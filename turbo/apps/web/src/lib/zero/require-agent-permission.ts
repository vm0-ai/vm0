type ForbiddenResponse = {
  status: 403;
  body: { error: { message: string; code: string } };
};

type AgentVisibility = "public" | "private";

/**
 * Check if the current user is allowed to modify the given agent.
 * Public agents may be modified by the owner or an org admin. Private agents
 * may only be modified by the owner.
 *
 * @param agentOwner - The userId that owns the agent
 * @param member - The resolved org member (userId + role)
 * @param action - Describes what is being attempted (for the error message)
 * @returns A 403 response if forbidden, or null if allowed
 */
export function requireAgentPermission(
  agentOwner: string,
  member: { userId: string; role: string },
  action: string,
  options?: { visibility?: AgentVisibility | null },
): ForbiddenResponse | null {
  if (member.userId === agentOwner) return null;
  if (options?.visibility !== "private" && member.role === "admin") return null;
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

/**
 * Check if the current user is an org admin.
 * Used for org-level resources (e.g. custom skills) that are not per-agent.
 *
 * @param member - The resolved org member
 * @param action - Describes what is being attempted (for the error message)
 * @returns A 403 response if forbidden, or null if allowed
 */
export function requireAdminPermission(
  member: { role: string },
  action: string,
): ForbiddenResponse | null {
  if (member.role === "admin") return null;
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
