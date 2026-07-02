import type {
  AnthropicResponse,
  AnthropicStopReason,
  OpenAIFinishReason,
  OpenAIResponse,
} from "../types";

export function mapFinishReason(
  reason: OpenAIFinishReason
): AnthropicStopReason {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "stop":
    case "content_filter":
    default:
      return "end_turn";
  }
}

function safeParseArguments(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return { raw: args };
}

export function openAIToAnthropic(
  res: OpenAIResponse,
  model: string
): AnthropicResponse {
  const choice = res.choices[0];
  const content: AnthropicResponse["content"] = [];
  let stopReason: AnthropicStopReason = "end_turn";

  if (choice) {
    const { message } = choice;
    if (message.reasoning_content) {
      content.push({ type: "thinking", thinking: message.reasoning_content });
    }
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: safeParseArguments(call.function.arguments),
      });
    }
    stopReason =
      (message.tool_calls?.length ?? 0) > 0
        ? "tool_use"
        : mapFinishReason(choice.finish_reason);
  }

  return {
    id: res.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}
