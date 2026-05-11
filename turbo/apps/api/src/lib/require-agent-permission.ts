type ForbiddenResponse = {
  readonly status: 403;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

/**
 * Owner-OR-admin gate for per-agent write operations.
 *
 * Returns a 403 envelope when neither condition is met, or null to allow.
 */
export function requireAgentPermission(
  agentOwner: string,
  member: { readonly userId: string; readonly role: string },
  action: string,
): ForbiddenResponse | null {
  if (member.role === "admin" || member.userId === agentOwner) {
    return null;
  }
  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only the agent owner or org admin can ${action}`,
        code: "FORBIDDEN",
      },
    },
  };
}
