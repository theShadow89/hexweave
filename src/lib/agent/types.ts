/**
 * Agent wire types, decoupled from any provider SDK. The agent runs entirely
 * client-side (BYOK): these shapes describe the tool catalog we send and the
 * normalised content blocks we get back, regardless of provider (Anthropic or
 * an OpenAI-compatible endpoint). See `runAgent.ts`.
 */

/** A single tool the model may call. `input_schema` is a JSON Schema object. */
export interface AgentTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Normalised assistant content: prose and/or tool calls. */
export type ContentBlock = TextBlock | ToolUseBlock;

/** What `runAgent` resolves to. */
export interface AgentResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  model: string;
}
