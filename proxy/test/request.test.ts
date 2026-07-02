import { describe, expect, it } from "bun:test";
import { anthropicToOpenAI, resolveModel } from "../src/convert/request";
import type { AnthropicRequest } from "../src/types";

const noMap = { modelMap: {}, defaultModel: "" };

function base(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

describe("resolveModel", () => {
  it("uses the model map first", () => {
    expect(
      resolveModel("claude-x", { modelMap: { "claude-x": "gpt-4o" }, defaultModel: "m" })
    ).toBe("gpt-4o");
  });
  it("falls back to the default model", () => {
    expect(resolveModel("claude-x", { modelMap: {}, defaultModel: "m" })).toBe("m");
  });
  it("passes through when no mapping applies", () => {
    expect(resolveModel("claude-x", noMap)).toBe("claude-x");
  });
});

describe("anthropicToOpenAI", () => {
  it("converts a simple string message", () => {
    const out = anthropicToOpenAI(base(), noMap);
    expect(out.model).toBe("claude-sonnet-4-20250514");
    expect(out.max_tokens).toBe(1024);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(out.stream).toBeUndefined();
  });

  it("prepends system as a system message (string and block forms)", () => {
    const s1 = anthropicToOpenAI(base({ system: "be terse" }), noMap);
    expect(s1.messages[0]).toEqual({ role: "system", content: "be terse" });

    const s2 = anthropicToOpenAI(
      base({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      noMap
    );
    expect(s2.messages[0]).toEqual({ role: "system", content: "a\nb" });
  });

  it("maps sampling params, stop sequences, stream, and metadata", () => {
    const out = anthropicToOpenAI(
      base({
        temperature: 0.5,
        top_p: 0.9,
        stop_sequences: ["END"],
        stream: true,
        metadata: { user_id: "user-123" },
      }),
      noMap
    );
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(["END"]);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.user).toBe("user-123");
  });

  it("converts base64 and url images to image_url parts", () => {
    const out = anthropicToOpenAI(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAA" },
              },
              { type: "image", source: { type: "url", url: "https://x/i.png" } },
            ],
          },
        ],
      }),
      noMap
    );
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "https://x/i.png" } },
    ]);
  });

  it("converts assistant tool_use into tool_calls and strips thinking", () => {
    const out = anthropicToOpenAI(
      base({
        messages: [
          { role: "user", content: "run it" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal", signature: "sig" },
              { type: "text", text: "running" },
              { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "ls" } },
            ],
          },
        ],
      }),
      noMap
    );
    const assistant = out.messages[1];
    expect(assistant).toEqual({
      role: "assistant",
      content: "running",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "bash", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
  });

  it("converts tool_result blocks into tool role messages", () => {
    const out = anthropicToOpenAI(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "file1\nfile2" }],
              },
              { type: "text", text: "what next?" },
            ],
          },
        ],
      }),
      noMap
    );
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "file1\nfile2" },
      { role: "user", content: "what next?" },
    ]);
  });

  it("converts tools and tool_choice variants", () => {
    const tools: AnthropicRequest["tools"] = [
      {
        name: "bash",
        description: "run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
      },
    ];
    const anyChoice = anthropicToOpenAI(
      base({ tools, tool_choice: { type: "any", disable_parallel_tool_use: true } }),
      noMap
    );
    expect(anyChoice.tools).toEqual([
      {
        type: "function",
        function: {
          name: "bash",
          description: "run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      },
    ]);
    expect(anyChoice.tool_choice).toBe("required");
    expect(anyChoice.parallel_tool_calls).toBe(false);

    const named = anthropicToOpenAI(
      base({ tools, tool_choice: { type: "tool", name: "bash" } }),
      noMap
    );
    expect(named.tool_choice).toEqual({
      type: "function",
      function: { name: "bash" },
    });
  });
});
