import { anthropicToOpenAI } from "./convert/request";
import { openAIToAnthropic } from "./convert/response";
import { translateStream } from "./convert/stream";
import { estimateTokens } from "./tokens";
import type { AnthropicRequest, OpenAIResponse } from "./types";

export interface Env {
  OPENAI_BASE_URL: string;
  MODEL_MAP?: string;
  DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
}

function anthropicError(status: number, type: string, message: string): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status }
  );
}

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return {};
}

async function handleMessages(request: Request, env: Env): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await request.json()) as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Invalid JSON body");
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return anthropicError(
      400,
      "invalid_request_error",
      "`model` and `messages` are required"
    );
  }

  const openAIRequest = anthropicToOpenAI(body, {
    modelMap: parseModelMap(env.MODEL_MAP),
    defaultModel: env.DEFAULT_MODEL ?? "",
  });

  const apiKey =
    env.OPENAI_API_KEY ??
    request.headers.get("x-api-key") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  const base = env.OPENAI_BASE_URL.replace(/\/+$/, "");
  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(openAIRequest),
    signal: request.signal,
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    const type =
      upstream.status === 401 || upstream.status === 403
        ? "authentication_error"
        : upstream.status === 429
          ? "rate_limit_error"
          : upstream.status >= 500
            ? "api_error"
            : "invalid_request_error";
    return anthropicError(
      upstream.status,
      type,
      `Upstream error (${upstream.status}): ${detail.slice(0, 2000)}`
    );
  }

  if (body.stream) {
    if (!upstream.body) {
      return anthropicError(502, "api_error", "Upstream returned no body");
    }
    return new Response(translateStream(upstream.body, body.model), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  const openAIResponse = (await upstream.json()) as OpenAIResponse;
  return Response.json(openAIToAnthropic(openAIResponse, body.model));
}

async function handleCountTokens(request: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await request.json()) as AnthropicRequest;
  } catch {
    return anthropicError(400, "invalid_request_error", "Invalid JSON body");
  }
  return Response.json({ input_tokens: estimateTokens(body) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      return handleCountTokens(request);
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      try {
        return await handleMessages(request, env);
      } catch (err) {
        return anthropicError(
          500,
          "api_error",
          err instanceof Error ? err.message : "Internal error"
        );
      }
    }
    return anthropicError(404, "not_found_error", `No route for ${url.pathname}`);
  },
};
