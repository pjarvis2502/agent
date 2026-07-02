# anthropic-openai-proxy

Cloudflare Worker that exposes the **Anthropic Messages API** (`/v1/messages`)
and forwards to any **OpenAI-compatible** upstream (`/chat/completions`). Lets
Claude Code (or any Anthropic SDK client) use an OpenAI-format backend.

```
Claude Code ──Anthropic format──▶ this Worker ──OpenAI format──▶ upstream
```

Supported: streaming SSE (full Anthropic event sequence), tool use (both
directions, incl. streamed `input_json_delta`), images (base64 + URL),
system prompts, `stop_sequences`, `tool_choice` (auto/any/none/tool),
thinking-block stripping on replay, `reasoning_content` → `thinking` blocks,
`/v1/messages/count_tokens` (estimation), Anthropic-shaped errors.

## Develop

```bash
cd proxy
bun install
bun test          # unit tests
bun run typecheck # tsc --noEmit
bun run dev       # wrangler dev (local worker on :8787)
```

## Deploy to Cloudflare Workers

```bash
bun install
bunx wrangler login
bunx wrangler secret put OPENAI_API_KEY   # upstream key (optional, see below)
bun run deploy
```

Config lives in `wrangler.toml` `[vars]`:

| Var | Meaning |
| --- | --- |
| `OPENAI_BASE_URL` | Upstream base, e.g. `https://api.openai.com/v1` |
| `MODEL_MAP` | JSON remap of incoming Anthropic model names, e.g. `{"claude-sonnet-4-20250514":"gpt-4o"}` |
| `DEFAULT_MODEL` | Fallback upstream model (empty = pass model through) |

If `OPENAI_API_KEY` is not set as a Worker secret, the client's `x-api-key`
(or `Authorization: Bearer`) header is forwarded to the upstream instead.

## Point Claude Code at it

```bash
export ANTHROPIC_BASE_URL=https://anthropic-openai-proxy.<your-subdomain>.workers.dev
export ANTHROPIC_API_KEY=anything   # forwarded upstream only if no OPENAI_API_KEY secret
claude
```
