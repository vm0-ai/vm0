/**
 * Canonical list of bot-level OAuth scopes requested when installing
 * the org-scoped Slack integration.
 *
 * This is the single source of truth — both the install route and the
 * status API reference this array.
 */
export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
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
 * - `null` → mismatch (no scopes recorded; installation predates scope tracking).
 * - Empty array → mismatch.
 */
export function hasAllBotScopes(storedScopes: string[] | null): boolean {
  if (storedScopes === null) return false;
  const stored = new Set(storedScopes);
  return SLACK_BOT_SCOPES.every((s) => {
    return stored.has(s);
  });
}
