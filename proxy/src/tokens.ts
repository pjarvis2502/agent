import type { AnthropicRequest } from "./types";

/**
 * Rough token estimate (~4 characters per token) covering system, message
 * content, and tool definitions. Claude Code only uses this for context-size
 * heuristics, so an estimate is sufficient.
 */
export function estimateTokens(req: AnthropicRequest): number {
  let chars = 0;

  const countUnknown = (value: unknown): void => {
    chars += JSON.stringify(value ?? "").length;
  };

  if (req.system !== undefined) countUnknown(req.system);
  for (const message of req.messages) countUnknown(message.content);
  for (const tool of req.tools ?? []) countUnknown(tool);

  return Math.max(1, Math.ceil(chars / 4));
}
