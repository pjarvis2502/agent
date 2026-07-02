import { describe, expect, it } from "bun:test";
import { mapFinishReason, openAIToAnthropic } from "../src/convert/response";
import type { OpenAIResponse } from "../src/types";

function res(overrides: Partial<OpenAIResponse["choices"][0]["message"]> = {},
  finish: OpenAIResponse["choices"][0]["finish_reason"] = "stop"): OpenAIResponse {
  return {
    id: "chatcmpl-1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello", ...overrides },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe("mapFinishReason", () => {
  it("maps finish reasons", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason(null)).toBe("end_turn");
  });
});

describe("openAIToAnthropic", () => {
  it("converts a text response", () => {
    const out = openAIToAnthropic(res(), "claude-sonnet-4");
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect(out.model).toBe("claude-sonnet-4");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.stop_reason).toBe("end_turn");
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("converts tool calls with parsed JSON arguments", () => {
    const out = openAIToAnthropic(
      res(
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        "tool_calls"
      ),
      "m"
    );
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("wraps unparseable tool arguments as { raw }", () => {
    const out = openAIToAnthropic(
      res(
        {
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: "not-json" },
            },
          ],
        },
        "tool_calls"
      ),
      "m"
    );
    expect(out.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "bash",
      input: { raw: "not-json" },
    });
  });

  it("maps reasoning_content to a thinking block", () => {
    const out = openAIToAnthropic(res({ reasoning_content: "deep thought" }), "m");
    expect(out.content[0]).toEqual({ type: "thinking", thinking: "deep thought" });
    expect(out.content[1]).toEqual({ type: "text", text: "hello" });
  });

  it("treats tool_calls presence as tool_use even if finish_reason is stop", () => {
    const out = openAIToAnthropic(
      res({
        tool_calls: [
          { id: "c", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      }),
      "m"
    );
    expect(out.stop_reason).toBe("tool_use");
  });
});
