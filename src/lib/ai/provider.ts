// AI provider factory (Vercel AI SDK, design doc §2.4).
// One switch between OpenAI / Anthropic / Ollama (local, privacy mode).
// All HTTP traffic goes through tauri-plugin-http so the webview never hits
// CORS issues, and API keys never leave the machine (stored in local SQLite).

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { generateText } from "ai";
import type { AISettings } from "@/lib/types";

export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    defaultModel: "qwen2.5:7b",
    models: ["qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b", "llama3.2:3b"],
  },
] as const;

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
