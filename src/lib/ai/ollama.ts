// OpenAI-compatible structured/plain generation (规划 §2.4).
//
// Serves Ollama (local, privacy mode) AND any third-party OpenAI-compatible
// endpoint (DeepSeek, opencode.ai gateway, etc.): AI SDK v7's openai adapter
// targets the Responses API (/responses) which third-party gateways do not
// implement, so this module speaks the plain /chat/completions protocol with
// real tool-call parameters, validated + retried against zod.
//
// Retry ladder (structured):
//   1. tool_choice "auto"    (model calls the tool with schema'd arguments)
//   2. tool_choice "required" (force a tool call)
//   3. prompt-embedded schema + json_object, then extract/repair JSON

import { toJSONSchema, z } from "zod";
import type { AISettings } from "@/lib/types";

let tauriFetchFn: typeof fetch | null = null;

async function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!tauriFetchFn) {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetchFn = mod.fetch as unknown as typeof fetch;
  }
  return tauriFetchFn(input, init);
}

export interface OllamaGenerationParams<T extends z.ZodType> {
  settings: AISettings;
  system: string;
  prompt: string;
  schema: T;
  /** optional pre-existing JSON for the model to reference */
  temperature?: number;
  /** injectable fetch (tests / non-Tauri hosts) */
  fetchImpl?: typeof fetch;
}

function endpoint(settings: AISettings): string {
  const base = (settings.baseUrl || "http://localhost:11434/v1").replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

function toolSpec(schema: z.ZodType): unknown {
  return {
    type: "function",
    function: {
      name: "generate_structured_output",
      description: "按照给定 JSON Schema 生成结构化输出",
      parameters: toJSONSchema(schema) as Record<string, unknown>,
    },
  };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function chat(
  settings: AISettings,
  messages: ChatMessage[],
  tools: unknown[],
  toolChoice: "auto" | "required" | "none",
  temperature: number,
  maxTokens = 4096,
  fetchImpl: typeof fetch = defaultFetch,
): Promise<{ message: ChatMessage }> {
  const res = await fetchImpl(endpoint(settings), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Ollama ignores auth; third-party gateways require the API key.
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      tools,
      tool_choice: toolChoice,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama 请求失败 (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Ollama 返回为空");
  return { message };
}

function extractToolArguments(msg: ChatMessage): string | null {
  const call = msg.tool_calls?.find((c) => c.function?.name === "generate_structured_output");
  return call?.function?.arguments ?? null;
}

/** Crude JSON repair: strip code fences and take the first {...} block. */
function repairJson(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return null;
}

export async function generateStructured<T extends z.ZodType>(
  params: OllamaGenerationParams<T>,
): Promise<z.infer<T>> {
  const { settings, system, prompt, schema, temperature = 0.4, fetchImpl } = params;
  const tools = [toolSpec(schema)];
  const systemMsg: ChatMessage = { role: "system", content: system };

  // ---- rung 1 & 2: tool calling --------------------------------------
  for (const choice of ["auto", "required"] as const) {
    const { message } = await chat(settings, [systemMsg, { role: "user", content: prompt }], tools, choice, temperature, 4096, fetchImpl);
    const args = extractToolArguments(message);
    if (!args) continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(args);
    } catch {
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    // Model returned a tool call but validation failed: feed the error back
    // and retry up to 2 times (small local models often need a nudge).
    const issues = result.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    for (let attempt = 0; attempt < 2; attempt++) {
      const { message: retryMsg } = await chat(
        settings,
        [
          systemMsg,
          { role: "user", content: prompt },
          { role: "assistant", content: null, tool_calls: message.tool_calls },
          {
            role: "tool",
            tool_call_id: message.tool_calls?.[0]?.id ?? "",
            content: `schema 校验失败：${issues}。请重新调用工具，严格按照 JSON Schema 的字段名和类型生成完整输出（不要省略任何必填字段，不要用中文代替枚举值）。`,
          },
        ],
        tools,
        "required",
        temperature,
        4096,
        fetchImpl,
      );
      const args2 = extractToolArguments(retryMsg);
      if (!args2) continue;
      try {
        const parsed2 = JSON.parse(args2);
        const result2 = schema.safeParse(parsed2);
        if (result2.success) return result2.data;
      } catch {
        continue;
      }
    }
  }

  // ---- rung 3: schema embedded in prompt, json_object mode ------------
  const schemaJson = JSON.stringify(toJSONSchema(schema), null, 1);
  const { message } = await chat(
    settings,
    [
      systemMsg,
      {
        role: "user",
        content: `${prompt}\n\n你必须输出一个 JSON 对象，且严格符合以下 JSON Schema（不要输出任何其他文字）：\n${schemaJson}`,
      },
    ],
    [],
    "none",
    temperature,
    4096,
    fetchImpl,
  );
  const raw = message.content ?? "";
  const repaired = repairJson(raw);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      throw new Error(
        `模型输出不符合 schema: ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error("模型输出不是合法 JSON，无法解析为计划");
      }
      throw e;
    }
  }
  throw new Error("模型未返回可解析的结构化输出");
}

// ---------------------------------------------------------------------------
// Plain text generation (review summary, connectivity ping)
// ---------------------------------------------------------------------------

export interface OllamaTextParams {
  settings: AISettings;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

/** Non-streaming /chat/completions text generation. */
export async function generatePlainText(
  params: OllamaTextParams,
): Promise<string> {
  const {
    settings,
    system,
    prompt,
    temperature = 0.5,
    maxOutputTokens = 2048,
    fetchImpl = defaultFetch,
  } = params;
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res = await fetchImpl(endpoint(settings), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature,
      max_tokens: maxOutputTokens,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`模型请求失败 (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回为空");
  return String(content);
}
