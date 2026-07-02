import type { OpenAIFinishReason, OpenAIStreamChunk } from "../types";
import { mapFinishReason } from "./response";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type BlockKind = "text" | "thinking" | "tool_use";

/**
 * Stateful translator from OpenAI chat-completion stream chunks to Anthropic
 * Messages SSE events. Feed parsed chunks in order, then call `finish()`.
 */
export class StreamTranslator {
  private started = false;
  private nextIndex = 0;
  private openKind: BlockKind | null = null;
  private openIndex = -1;
  /** OpenAI tool_call index -> Anthropic content block index. */
  private toolBlocks = new Map<number, number>();
  private finishReason: OpenAIFinishReason = null;
  private sawToolCall = false;
  private outputTokens = 0;
  private inputTokens = 0;
  private messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;

  constructor(private model: string) {}

  private start(): string {
    if (this.started) return "";
    this.started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private closeBlock(): string {
    if (this.openKind === null) return "";
    const out = sse("content_block_stop", {
      type: "content_block_stop",
      index: this.openIndex,
    });
    this.openKind = null;
    this.openIndex = -1;
    return out;
  }

  private openBlock(kind: BlockKind, block: Record<string, unknown>): string {
    let out = this.closeBlock();
    this.openKind = kind;
    this.openIndex = this.nextIndex++;
    out += sse("content_block_start", {
      type: "content_block_start",
      index: this.openIndex,
      content_block: block,
    });
    return out;
  }

  handleChunk(chunk: OpenAIStreamChunk): string {
    let out = this.start();

    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const { delta } = choice;

    if (delta.reasoning_content) {
      if (this.openKind !== "thinking") {
        out += this.openBlock("thinking", { type: "thinking", thinking: "" });
      }
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.openIndex,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      });
    }

    if (delta.content) {
      if (this.openKind !== "text") {
        out += this.openBlock("text", { type: "text", text: "" });
      }
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.openIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const call of delta.tool_calls ?? []) {
      this.sawToolCall = true;
      let blockIndex = this.toolBlocks.get(call.index);
      if (blockIndex === undefined) {
        out += this.openBlock("tool_use", {
          type: "tool_use",
          id: call.id ?? `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
          name: call.function?.name ?? "",
          input: {},
        });
        blockIndex = this.openIndex;
        this.toolBlocks.set(call.index, blockIndex);
      }
      if (call.function?.arguments) {
        out += sse("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: call.function.arguments,
          },
        });
      }
    }

    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return out;
  }

  finish(): string {
    let out = this.start();
    out += this.closeBlock();
    const stopReason = this.sawToolCall
      ? "tool_use"
      : mapFinishReason(this.finishReason);
    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
      },
    });
    out += sse("message_stop", { type: "message_stop" });
    return out;
  }
}

/**
 * Wrap an upstream OpenAI SSE body into an Anthropic Messages SSE body.
 */
export function translateStream(
  upstream: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const translator = new StreamTranslator(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;

  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    text: string
  ): void => {
    if (text) controller.enqueue(encoder.encode(text));
  };

  const processLine = (
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      if (!done) {
        done = true;
        emit(controller, translator.finish());
      }
      return;
    }
    try {
      const chunk = JSON.parse(payload) as OpenAIStreamChunk;
      emit(controller, translator.handleChunk(chunk));
    } catch {
      // Ignore malformed keep-alive / comment lines.
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(value, controller) {
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line, controller);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      if (buffer.trim()) processLine(buffer, controller);
      if (!done) {
        done = true;
        emit(controller, translator.finish());
      }
    },
  });

  return upstream.pipeThrough(transform);
}
