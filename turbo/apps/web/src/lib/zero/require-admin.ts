import { isDefaultAgentCompose } from "./resolve-default-agent";

type ForbiddenResponse = {
  status: 403;
  body: { error: { message: string; code: string } };
};

/**
 * Check if the current user is allowed to modify the given agent.
 * Non-admin users are forbidden from modifying the default agent.
 *
 * @param label - Describes what is being modified (e.g. "configuration", "skills", "profile")
 * @returns A 403 response if forbidden, or null if allowed
 */
export async function requireAdminForDefaultAgent(
  orgId: string,
  composeId: string,
  memberRole: string,
  label: string,
): Promise<ForbiddenResponse | null> {
  if (memberRole === "admin") return null;
  const isDefault = await isDefaultAgentCompose(orgId, composeId);
  if (!isDefault) return null;
  return {
    status: 403 as const,
    body: {
      error: {
        message: `Only org admins can modify the default agent's ${label}`,
        code: "FORBIDDEN",
      },
    },
  };
}
