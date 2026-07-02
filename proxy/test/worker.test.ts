import { afterEach, describe, expect, it } from "bun:test";
import worker, { type Env } from "../src/index";

const env: Env = {
  OPENAI_BASE_URL: "https://upstream.example/v1",
  MODEL_MAP: '{"claude-sonnet-4":"gpt-4o"}',
  DEFAULT_MODEL: "",
  OPENAI_API_KEY: "sk-test",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockUpstream(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { calls };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://proxy.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("worker routes", () => {
  it("serves /health", async () => {
    const res = await worker.fetch(new Request("https://proxy.example/health"), env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toEqual({ status: "ok" });
  });

  it("returns Anthropic-shaped 404 for unknown routes", async () => {
    const res = await worker.fetch(new Request("https://proxy.example/nope"), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found_error");
  });

  it("estimates tokens on /v1/messages/count_tokens", async () => {
    const res = await worker.fetch(
      post("/v1/messages/count_tokens", {
        model: "claude-sonnet-4",
        max_tokens: 1,
        messages: [{ role: "user", content: "hello world" }],
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it("proxies /v1/messages: maps model, auth header, and converts back", async () => {
    const { calls } = mockUpstream(() =>
      Response.json({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi there" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })
    );

    const res = await worker.fetch(
      post("/v1/messages", {
        model: "claude-sonnet-4",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      env
    );

    expect(calls[0]?.url).toBe("https://upstream.example/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("gpt-4o");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
    };
    expect(body.type).toBe("message");
    expect(body.model).toBe("claude-sonnet-4");
    expect(body.content).toEqual([{ type: "text", text: "hi there" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  it("maps upstream errors to Anthropic error shapes", async () => {
    mockUpstream(() => new Response("nope", { status: 401 }));
    const res = await worker.fetch(
      post("/v1/messages", {
        model: "claude-sonnet-4",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  it("streams Anthropic SSE when stream=true", async () => {
    const encoder = new TextEncoder();
    mockUpstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"hey"}}]}\n\n'
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    );

    const res = await worker.fetch(
      post("/v1/messages", {
        model: "claude-sonnet-4",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
      env
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta"');
    expect(text).toContain("event: message_stop");
  });

  it("rejects requests missing model/messages", async () => {
    const res = await worker.fetch(post("/v1/messages", { foo: 1 }), env);
    expect(res.status).toBe(400);
  });
});
