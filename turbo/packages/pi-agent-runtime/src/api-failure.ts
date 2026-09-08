const CODEX_USAGE_LIMIT_SNIPPETS = [
  "usage limit",
  "usage_limit",
  "usage-limit",
  "usagelimit",
] as const;

/** Reduce native provider diagnostics to the only subscription product states. */
export function classifyPiApiProviderFailure(
  error: unknown,
): "reconnect_required" | "usage_limit" | undefined {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;
  if (!message) {
    return undefined;
  }
  const normalized = message.toLowerCase();
  if (
    normalized.includes("token_refresh_failed") &&
    normalized.includes("codex-oauth-token") &&
    normalized.includes("reconnect_required")
  ) {
    return "reconnect_required";
  }
  return CODEX_USAGE_LIMIT_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet);
  })
    ? "usage_limit"
    : undefined;
}
