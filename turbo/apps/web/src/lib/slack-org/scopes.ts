/**
 * Canonical list of bot-level OAuth scopes requested when installing
 * the org-scoped Slack integration.
 *
 * This is the single source of truth — both the install route and the
 * status API reference this array.
 */
export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
];

/**
 * Check whether stored scopes cover all currently required bot scopes.
 *
 * - `null` → permissive: treat as "no mismatch" (backward compat for
 *   installations that pre-date scope tracking).
 * - Empty array → mismatch (scopes were recorded but none match).
 */
export function hasAllBotScopes(storedScopes: string[] | null): boolean {
  if (storedScopes === null) return true;
  const stored = new Set(storedScopes);
  return SLACK_BOT_SCOPES.every((s) => stored.has(s));
}
