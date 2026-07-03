type ForbiddenResponse = {
  readonly status: 403;
  readonly body: {
    readonly error: { readonly message: string; readonly code: string };
  };
};

type AgentVisibility = "public" | "private";

/**
 * Owner/admin gate for per-agent write operations.
 *
 * Public agents may be modified by the owner or an org admin. Private agents
 * may only be modified by the owner.
 *
 * Returns a 403 envelope when neither condition is met, or null to allow.
 */
export function requireAgentPermission(
  agentOwner: string,
  member: { readonly userId: string; readonly role: string },
  action: string,
  options?: { readonly visibility?: AgentVisibility | null },
): ForbiddenResponse | null {
  if (member.userId === agentOwner) {
    return null;
  }

  if (options?.visibility !== "private" && member.role === "admin") {
    return null;
  }

  const ownerLabel =
    options?.visibility === "private"
      ? "the private agent owner"
      : "the agent owner or org admin";

  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only ${ownerLabel} can ${action}`,
        code: "FORBIDDEN",
      },
    },
  };
}

export function requireAdminPermission(
  member: { readonly role: string },
  action: string,
): ForbiddenResponse | null {
  if (member.role === "admin") {
    return null;
  }

  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only org admins can ${action}`,
        code: "FORBIDDEN",
      },
    },
  };
}
