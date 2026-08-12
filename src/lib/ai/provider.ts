// AI provider factory (Vercel AI SDK, design doc §2.4).
// One switch between OpenAI-compatible / Anthropic / Ollama (local, privacy mode).
// The OpenAI slot accepts ANY OpenAI-compatible endpoint (official OpenAI,
// DeepSeek, Moonshot, Qwen-DashScope, etc.) via a configurable base URL.
// All HTTP traffic goes through tauri-plugin-http so the webview never hits
// CORS issues, and API keys never leave the machine (stored in local SQLite).

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { generateText } from "ai";
import type { AISettings } from "@/lib/types";

/** Per-provider default base URLs (applied on provider switch). */
export const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "",
  ollama: "http://localhost:11434/v1",
};

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI 兼容",
    hint: "支持官方 OpenAI 及 DeepSeek / Moonshot 等第三方兼容端点",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: [
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-4.1-mini",
      "gpt-4.1",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "官方 Anthropic API",
    defaultModel: "claude-sonnet-4-20250514",
    defaultBaseUrl: "",
    models: [
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    hint: "本地推理，隐私模式",
    defaultModel: "qwen2.5:7b",
    defaultBaseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b", "llama3.2:3b"],
  },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function providerLabel(id: string): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

/** Shared fetch routed through the Rust HTTP plugin (no CORS, no proxies). */
const routeFetch = tauriFetch as unknown as typeof fetch;

export function getModel(s: AISettings) {
  const common = { fetch: routeFetch };
  switch (s.provider) {
    case "openai": {
      const openai = createOpenAI({
        apiKey: s.apiKey || "sk-not-set",
        // Any OpenAI-compatible third-party endpoint (DeepSeek, etc.)
        baseURL: s.baseUrl || PROVIDER_DEFAULT_BASE_URL.openai,
        ...common,
      });
      return openai(s.model || "gpt-4o-mini");
    }
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: s.apiKey || "sk-ant-not-set",
        ...common,
      });
      return anthropic(s.model || "claude-sonnet-4-20250514");
    }
    case "ollama":
    default: {
      const ollama = createOpenAICompatible({
        name: "ollama",
        baseURL: s.baseUrl || "http://localhost:11434/v1",
        apiKey: "ollama",
        ...common,
      });
      return ollama(s.model || "qwen2.5:7b");
    }
  }
}

/** Quick connectivity check for the settings page. */
export async function pingModel(s: AISettings): Promise<{ ok: boolean; detail: string }> {
  try {
    const { text } = await generateText({
      model: getModel(s),
      prompt: "Reply with the single word: pong",
      maxOutputTokens: 10,
    });
    return { ok: true, detail: text.trim().slice(0, 120) || "connected" };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
