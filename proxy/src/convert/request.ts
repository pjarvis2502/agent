import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIRequest,
  OpenAIToolChoice,
} from "../types";

function imageToPart(block: AnthropicImageBlock): OpenAIContentPart {
  const src = block.source;
  const url =
    src.type === "url" ? src.url : `data:${src.media_type};base64,${src.data}`;
  return { type: "image_url", image_url: { url } };
}

function toolResultToString(
  content: AnthropicToolResultBlock["content"]
): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : "[image omitted]"))
    .join("\n");
}

function systemToString(system: AnthropicRequest["system"]): string | null {
  if (system === undefined) return null;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

/** Collapse content parts to a plain string when they are all text. */
function simplify(parts: OpenAIContentPart[]): string | OpenAIContentPart[] {
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as { type: "text"; text: string }).text).join("");
  }
  return parts;
}

function convertUserBlocks(
  blocks: AnthropicContentBlock[],
  out: OpenAIChatMessage[]
): void {
  // tool_result blocks become individual `tool` role messages and must come
  // before the rest of the user content.
  const parts: OpenAIContentPart[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "tool_result":
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: toolResultToString(block.content),
        });
        break;
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image":
        parts.push(imageToPart(block));
        break;
      case "document": {
        const label = block.title ?? "document";
        const text =
          block.source.type === "text" && block.source.data
            ? block.source.data
            : `[attached document: ${label}]`;
        parts.push({ type: "text", text });
        break;
      }
      default:
        // thinking / redacted_thinking / tool_use are not valid in user
        // messages; skip anything unexpected.
        break;
    }
  }
  if (parts.length > 0) {
    out.push({ role: "user", content: simplify(parts) });
  }
}

function convertAssistantBlocks(
  blocks: AnthropicContentBlock[],
  out: OpenAIChatMessage[]
): void {
  const texts: string[] = [];
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;
      // thinking / redacted_thinking blocks are internal to Anthropic models
      // and are stripped when replaying history to an OpenAI backend.
      default:
        break;
    }
  }
  const msg: OpenAIChatMessage = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("") : null,
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  if (msg.content !== null || toolCalls.length > 0) out.push(msg);
}

function convertToolChoice(
  choice: NonNullable<AnthropicRequest["tool_choice"]>
): { tool_choice: OpenAIToolChoice; parallel_tool_calls?: boolean } {
  const parallel =
    "disable_parallel_tool_use" in choice && choice.disable_parallel_tool_use
      ? { parallel_tool_calls: false }
      : {};
  switch (choice.type) {
    case "auto":
      return { tool_choice: "auto", ...parallel };
    case "any":
      return { tool_choice: "required", ...parallel };
    case "none":
      return { tool_choice: "none" };
    case "tool":
      return {
        tool_choice: { type: "function", function: { name: choice.name } },
        ...parallel,
      };
  }
}

export interface ModelResolution {
  modelMap: Record<string, string>;
  defaultModel: string;
}

export function resolveModel(incoming: string, res: ModelResolution): string {
  const mapped = res.modelMap[incoming];
  if (mapped) return mapped;
  if (res.defaultModel) return res.defaultModel;
  return incoming;
}

export function anthropicToOpenAI(
  req: AnthropicRequest,
  resolution: ModelResolution
): OpenAIRequest {
  const messages: OpenAIChatMessage[] = [];

  const system = systemToString(req.system);
  if (system !== null && system.length > 0) {
    messages.push({ role: "system", content: system });
  }

  for (const message of req.messages) {
    const blocks: AnthropicContentBlock[] =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content } satisfies AnthropicTextBlock]
        : message.content;
    if (message.role === "user") {
      convertUserBlocks(blocks, messages);
    } else {
      convertAssistantBlocks(blocks, messages);
    }
  }

  const out: OpenAIRequest = {
    model: resolveModel(req.model, resolution),
    messages,
    max_tokens: req.max_tokens,
  };

  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences !== undefined && req.stop_sequences.length > 0) {
    out.stop = req.stop_sequences;
  }
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (req.metadata?.user_id) out.user = req.metadata.user_id.slice(0, 64);

  if (req.tools !== undefined && req.tools.length > 0) {
    out.tools = req.tools
      .filter((t) => t.type === undefined || t.type.startsWith("custom"))
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          ...(t.description !== undefined && { description: t.description }),
          parameters: t.input_schema ?? { type: "object", properties: {} },
        },
      }));
  }
  if (req.tool_choice !== undefined && out.tools !== undefined) {
    Object.assign(out, convertToolChoice(req.tool_choice));
  }

  return out;
}
