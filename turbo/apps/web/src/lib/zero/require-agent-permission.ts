type ForbiddenResponse = {
  status: 403;
  body: { error: { message: string; code: string } };
};

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
