import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent/tools";
import { SYSTEM_PROMPTS, type AgentMode } from "@/lib/agent/prompts";
import { loadAgentConfig, type AgentConfig } from "@/lib/agent/config";

export const runtime = "nodejs";

interface AgentRequest {
  mode: AgentMode;
  messages: Anthropic.MessageParam[];
  context?: unknown;
}

interface NormalisedResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
  model: string;
  provider: AgentConfig["provider"];
  usage?: unknown;
}

export async function POST(req: Request) {
  let body: AgentRequest;
  try {
    body = (await req.json()) as AgentRequest;
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON." }, { status: 400 });
  }

  const mode = body.mode ?? "chat-config";
  const systemPrompt = SYSTEM_PROMPTS[mode];
  if (!systemPrompt) {
    return NextResponse.json({ error: `Unknown mode: ${mode}` }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages must be a non-empty array." }, { status: 400 });
  }

  const cfg = loadAgentConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ error: "Agent is disabled." }, { status: 404 });
  }
  try {
    const result =
      cfg.provider === "anthropic"
        ? await runAnthropic(systemPrompt, body, cfg)
        : await runOpenAiCompatible(systemPrompt, body, cfg);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: error.message, type: error.type, status: error.status, provider: cfg.provider },
        { status: error.status ?? 500 },
      );
    }
    if (error instanceof Error && "status" in error) {
      const e = error as Error & { status?: number; body?: string };
      return NextResponse.json(
        { error: e.message, detail: e.body, provider: cfg.provider, status: e.status ?? 500 },
        { status: e.status ?? 500 },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message, provider: cfg.provider }, { status: 500 });
  }
}

async function runAnthropic(
  systemPrompt: string,
  body: AgentRequest,
  cfg: AgentConfig,
): Promise<NormalisedResponse> {
  if (!cfg.apiKey) {
    const err = new Error(
      "ANTHROPIC_API_KEY is not configured. Add it to .env.local and restart the dev server.",
    ) as Error & { status: number };
    err.status = 503;
    throw err;
  }
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: 2048,
    system: [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: `Current page state:\n${JSON.stringify(body.context ?? {}, null, 2)}` },
    ],
    tools: AGENT_TOOLS,
    messages: body.messages,
  });
  return {
    content: response.content,
    stop_reason: response.stop_reason,
    model: response.model,
    provider: cfg.provider,
    usage: response.usage,
  };
}

/**
 * Call any OpenAI Chat Completions-compatible endpoint (Ollama, LM Studio,
 * llama.cpp, vLLM, LocalAI, Together, Groq, etc.) and translate the response
 * back into the Anthropic content-block shape the frontend expects.
 */
async function runOpenAiCompatible(
  systemPrompt: string,
  body: AgentRequest,
  cfg: AgentConfig,
): Promise<NormalisedResponse> {
  if (!cfg.model) {
    const err = new Error(
      "AGENT_MODEL is not set. Add AGENT_MODEL (e.g. llama3.1:8b) to .env.local and restart.",
    ) as Error & { status: number };
    err.status = 503;
    throw err;
  }
  const baseUrl = (cfg.baseUrl ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    const err = new Error("AGENT_BASE_URL is not set.") as Error & { status: number };
    err.status = 503;
    throw err;
  }

  const oaiTools = AGENT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const oaiMessages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content: `${systemPrompt}\n\nCurrent page state:\n${JSON.stringify(body.context ?? {}, null, 2)}`,
    },
  ];
  for (const m of body.messages) {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((b) => (b.type === "text" ? b.text : ""))
              .filter(Boolean)
              .join("\n")
          : "";
    oaiMessages.push({ role: m.role, content: text });
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: oaiMessages,
      tools: oaiTools,
      tool_choice: "auto",
      max_tokens: 2048,
      stream: false,
    }),
  }).catch((cause: Error) => {
    const err = new Error(
      `Could not reach ${baseUrl}: ${cause.message}. Is the local server running?`,
    ) as Error & { status: number };
    err.status = 502;
    throw err;
  });

  if (!res.ok) {
    const bodyText = await res.text();
    const err = new Error(`${baseUrl} returned ${res.status}: ${bodyText.slice(0, 200)}`) as Error & {
      status: number;
      body: string;
    };
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }

  type OaiResponse = {
    model?: string;
    usage?: unknown;
    choices: Array<{
      finish_reason: string | null;
      message: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  const data = (await res.json()) as OaiResponse;
  const choice = data.choices?.[0];
  if (!choice) {
    const err = new Error(`${baseUrl} returned no choices.`) as Error & { status: number };
    err.status = 502;
    throw err;
  }

  const content: Anthropic.ContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content } as Anthropic.TextBlock);
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = { __raw: tc.function.arguments };
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    } as unknown as Anthropic.ToolUseBlock);
  }

  return {
    content,
    stop_reason: choice.finish_reason ?? "end_turn",
    model: data.model ?? cfg.model,
    provider: cfg.provider,
    usage: data.usage,
  };
}
