import { describe, expect, it } from "bun:test";
import { translateStream } from "../src/convert/stream";
import { estimateTokens } from "../src/tokens";

function openAIStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

interface ParsedEvent {
  event: string;
  data: Record<string, unknown>;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ParsedEvent[]> {
  const text = await new Response(stream).text();
  const events: ParsedEvent[] = [];
  for (const block of text.split("\n\n")) {
    const eventMatch = block.match(/^event: (.+)$/m);
    const dataMatch = block.match(/^data: (.+)$/m);
    if (eventMatch?.[1] && dataMatch?.[1]) {
      events.push({
        event: eventMatch[1],
        data: JSON.parse(dataMatch[1]) as Record<string, unknown>,
      });
    }
  }
  return events;
}

describe("translateStream", () => {
  it("translates a text stream into Anthropic SSE events", async () => {
    const events = await collect(
      translateStream(
        openAIStream([
          { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
          { choices: [{ index: 0, delta: { content: "lo" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
        ]),
        "claude-sonnet-4"
      )
    );

    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[0]?.data.message as { model: string };
    expect(start.model).toBe("claude-sonnet-4");

    const deltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { text: string }).text);
    expect(deltas.join("")).toBe("Hello");

    const messageDelta = events.find((e) => e.event === "message_delta")?.data;
    expect((messageDelta?.delta as { stop_reason: string }).stop_reason).toBe(
      "end_turn"
    );
    expect(messageDelta?.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
  });

  it("translates streamed tool calls into tool_use blocks", async () => {
    const events = await collect(
      translateStream(
        openAIStream([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "bash", arguments: "" } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
        "m"
      )
    );

    const blockStart = events.find((e) => e.event === "content_block_start")?.data;
    expect(blockStart?.content_block).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "bash",
      input: {},
    });

    const jsonDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data.delta as { partial_json: string }).partial_json);
    expect(jsonDeltas.join("")).toBe('{"cmd":"ls"}');

    const messageDelta = events.find((e) => e.event === "message_delta")?.data;
    expect((messageDelta?.delta as { stop_reason: string }).stop_reason).toBe(
      "tool_use"
    );
  });

  it("switches blocks between text and tool_use with sequential indexes", async () => {
    const events = await collect(
      translateStream(
        openAIStream([
          { choices: [{ index: 0, delta: { content: "Let me check." } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "f", arguments: "{}" } },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]),
        "m"
      )
    );

    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);
    expect((starts[0]?.data.content_block as { type: string }).type).toBe("text");
    expect((starts[1]?.data.content_block as { type: string }).type).toBe("tool_use");
    expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(2);
  });

  it("emits a complete event sequence even for an empty stream", async () => {
    const events = await collect(translateStream(openAIStream([]), "m"));
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("estimateTokens", () => {
  it("estimates roughly chars/4 and is at least 1", () => {
    expect(
      estimateTokens({ model: "m", max_tokens: 1, messages: [] })
    ).toBeGreaterThanOrEqual(1);
    const tokens = estimateTokens({
      model: "m",
      max_tokens: 1,
      system: "x".repeat(400),
      messages: [{ role: "user", content: "y".repeat(400) }],
    });
    expect(tokens).toBeGreaterThan(150);
    expect(tokens).toBeLessThan(250);
  });
});
