export type AgentProvider = "anthropic" | "openai_compatible";

export interface AgentConfig {
  /** When false, the agent UI is hidden and the API endpoints return 404. */
  enabled: boolean;
  provider: AgentProvider;
  /** Resolved model id. */
  model: string;
  /** OpenAI-compatible endpoint base URL (only for openai_compatible). */
  baseUrl?: string;
  /** API key (Anthropic key or OpenAI-compatible bearer). May be empty for local servers without auth. */
  apiKey?: string;
}

export type AgentConfigStatus =
  | { enabled: false }
  | {
      enabled: true;
      provider: AgentProvider;
      model: string;
      baseUrl?: string;
    };

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Read env vars at request time and resolve the active provider. */
export function loadAgentConfig(): AgentConfig {
  const enabled = envFlag("AGENT_ENABLED");
  const provider: AgentProvider =
    process.env.AGENT_PROVIDER === "openai_compatible" ? "openai_compatible" : "anthropic";

  if (provider === "anthropic") {
    return {
      enabled,
      provider,
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      apiKey: process.env.ANTHROPIC_API_KEY || "",
    };
  }

  return {
    enabled,
    provider,
    model: process.env.AGENT_MODEL || "",
    baseUrl: process.env.AGENT_BASE_URL || "http://localhost:11434/v1",
    apiKey: process.env.AGENT_API_KEY || "",
  };
}

/** Public-safe snapshot returned by GET /api/agent/config. Strips secrets. */
export function describeAgentConfig(cfg: AgentConfig): AgentConfigStatus {
  if (!cfg.enabled) return { enabled: false };
  if (cfg.provider === "anthropic") {
    return {
      enabled: true,
      provider: cfg.provider,
      model: cfg.model,
    };
  }
  return {
    enabled: true,
    provider: cfg.provider,
    model: cfg.model || "(unset)",
    baseUrl: cfg.baseUrl,
  };
}
