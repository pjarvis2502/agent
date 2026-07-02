// Minimal shapes for the two wire formats. Only the fields the proxy touches
// are typed; unknown fields are preserved where the code passes objects through.

// ---------- Anthropic Messages API ----------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: {
    type: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  title?: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicDocumentBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  type?: string;
}

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "none" }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: "enabled" | "disabled" | "adaptive"; budget_tokens?: number };
  metadata?: { user_id?: string };
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock>;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// ---------- OpenAI Chat Completions API ----------

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
  user?: string;
}

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | null;

export interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: OpenAIFinishReason;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface OpenAIStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: OpenAIFinishReason;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}
