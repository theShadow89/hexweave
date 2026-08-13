/**
 * Agent configuration types and defaults. The agent is BYOK and fully
 * client-side: the user picks a provider/model in the UI (see AgentSettings)
 * and the API key is stored locally (OS keychain on desktop, passphrase-
 * encrypted in the browser on web — see `keystore.ts`). There are no server
 * routes and no env-based config anymore.
 */

export type AgentProvider = "anthropic" | "openai_compatible";

/** Non-secret, user-editable configuration persisted in localStorage. */
export interface AgentUiConfig {
  provider: AgentProvider;
  /** Model id (e.g. "claude-sonnet-5" or "llama3.1:8b"). */
  model: string;
  /** OpenAI-compatible endpoint base URL; ignored for the anthropic provider. */
  baseUrl?: string;
}

/** Anthropic REST version pinned by the client. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Sensible defaults shown in the settings form for a fresh setup. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_OPENAI_BASE_URL = "http://localhost:11434/v1";

export function defaultConfig(provider: AgentProvider): AgentUiConfig {
  return provider === "anthropic"
    ? { provider, model: DEFAULT_ANTHROPIC_MODEL }
    : { provider, model: "", baseUrl: DEFAULT_OPENAI_BASE_URL };
}
