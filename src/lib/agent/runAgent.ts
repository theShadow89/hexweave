"use client";

import { AGENT_TOOLS } from "./tools";
import { SYSTEM_PROMPTS, type AgentMode } from "./prompts";
import { ANTHROPIC_VERSION, type AgentUiConfig } from "./config";
import type { AgentResponse, ContentBlock } from "./types";

/**
 * Client-side agent call (BYOK). Runs directly from the browser/renderer to the
 * chosen provider using the locally-stored key — no Intella server involved.
 * Replaces the former `/api/agent` route; the response is normalised to the
 * same `{ content: ContentBlock[] }` shape the UI already consumes.
 *
 * CORS: Anthropic requires the `anthropic-dangerous-direct-browser-access`
 * header (set below). OpenAI-compatible local servers (e.g. Ollama) must allow
 * this origin (set OLLAMA_ORIGINS).
 */

export interface RunAgentParams {
  config: AgentUiConfig;
  apiKey: string;
  mode: AgentMode;
  message: string;
  context: unknown;
}

export async function runAgent(params: RunAgentParams): Promise<AgentResponse> {
  const systemPrompt = SYSTEM_PROMPTS[params.mode];
  if (!systemPrompt) throw new Error(`Unknown mode: ${params.mode}`);
  return params.config.provider === "anthropic"
    ? runAnthropic(systemPrompt, params)
    : runOpenAiCompatible(systemPrompt, params);
}

async function runAnthropic(systemPrompt: string, p: RunAgentParams): Promise<AgentResponse> {
  if (!p.apiKey) throw new Error("Missing Anthropic API key.");
  const res = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: p.config.model,
      max_tokens: 2048,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Current page state:\n${JSON.stringify(p.context ?? {}, null, 2)}` },
      ],
      tools: AGENT_TOOLS,
      messages: [{ role: "user", content: p.message }],
    }),
  });

  type AnthropicMessage = {
    content?: Array<Record<string, unknown>>;
    stop_reason?: string | null;
    model?: string;
  };
  const data = (await res.json()) as AnthropicMessage;
  const content: ContentBlock[] = [];
  for (const b of data.content ?? []) {
    if (b.type === "text") {
      content.push({ type: "text", text: String(b.text ?? "") });
    } else if (b.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: String(b.id),
        name: String(b.name),
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { content, stop_reason: data.stop_reason ?? null, model: data.model ?? p.config.model };
}

/**
 * Call any OpenAI Chat Completions-compatible endpoint (Ollama, LM Studio,
 * llama.cpp, vLLM, LocalAI, Together, Groq, ...) and translate the response
 * back into the content-block shape the frontend expects.
 */
async function runOpenAiCompatible(systemPrompt: string, p: RunAgentParams): Promise<AgentResponse> {
  if (!p.config.model) throw new Error("Set a model id in the agent settings.");
  const baseUrl = (p.config.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Set a base URL in the agent settings.");

  const oaiTools = AGENT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const res = await fetchJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: p.config.model,
      messages: [
        {
          role: "system",
          content: `${systemPrompt}\n\nCurrent page state:\n${JSON.stringify(p.context ?? {}, null, 2)}`,
        },
        { role: "user", content: p.message },
      ],
      tools: oaiTools,
      tool_choice: "auto",
      max_tokens: 2048,
      stream: false,
    }),
  }).catch((cause: Error) => {
    throw new Error(`Could not reach ${baseUrl}: ${cause.message}. Is the server running and CORS allowed?`);
  });

  type OaiResponse = {
    model?: string;
    choices?: Array<{
      finish_reason: string | null;
      message: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  const data = (await res.json()) as OaiResponse;
  const choice = data.choices?.[0];
  if (!choice) throw new Error(`${baseUrl} returned no choices.`);

  const content: ContentBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const tc of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = { __raw: tc.function.arguments };
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  return { content, stop_reason: choice.finish_reason ?? "end_turn", model: data.model ?? p.config.model };
}

/** fetch that throws a readable Error (with provider message) on non-2xx. */
async function fetchJson(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? detail);
    } catch {
      /* keep raw text */
    }
    throw new Error(`Provider returned ${res.status}: ${detail}`);
  }
  return res;
}
