import { eq, and, or } from "drizzle-orm";
import { agentPermissions } from "../../db/schema/agent-permission";
import { agentComposes } from "../../db/schema/agent-compose";
import { scopes } from "../../db/schema/scope";
import { orgMemberships } from "../../db/schema/org-membership";
import { logger } from "../logger";

const log = logger("agent:permission");

/**
 * Check if a user can access an agent compose
 *
 * Access is granted if:
 * 1. User is the owner of the compose
 * 2. Compose is in a system scope (public)
 * 3. Compose is in an organization scope and user is a member
 * 4. Compose has a 'public' permission entry
 * 5. User's email matches an 'email' permission entry
 */
export async function canAccessCompose(
  userId: string,
  userEmail: string,
  composeId: string,
): Promise<boolean> {
  // 1. Get compose info
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) return false;

  // 2. Owner always has access
  if (compose.userId === userId) return true;

  // 3. Check scope type
  const [scope] = await globalThis.services.db
    .select()
    .from(scopes)
    .where(eq(scopes.id, compose.scopeId))
    .limit(1);

  // 3a. System scope (public)
  if (scope?.type === "system") return true;

  // 3b. Organization scope - check membership
  if (scope?.type === "organization") {
    const [membership] = await globalThis.services.db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.scopeId, scope.id),
          eq(orgMemberships.userId, userId),
        ),
      )
      .limit(1);

    if (membership) return true;
  }

  // 4. Check ACL table
  const [permission] = await globalThis.services.db
    .select()
    .from(agentPermissions)
    .where(
      and(
        eq(agentPermissions.agentComposeId, composeId),
        or(
          eq(agentPermissions.granteeType, "public"),
          and(
            eq(agentPermissions.granteeType, "email"),
            eq(agentPermissions.granteeEmail, userEmail),
          ),
        ),
      ),
    )
    .limit(1);

  return !!permission;
}

/**
 * Add a permission to an agent compose
 */
export async function addPermission(
  composeId: string,
  granteeType: "public" | "email",
  grantedBy: string,
  granteeEmail?: string,
): Promise<void> {
  await globalThis.services.db.insert(agentPermissions).values({
    agentComposeId: composeId,
    granteeType,
    granteeEmail: granteeType === "email" ? granteeEmail : null,
    grantedBy,
  });
  log.info(
    `Permission added: ${granteeType} ${granteeEmail ?? ""} -> ${composeId}`,
  );
}

/**
 * Remove a permission from an agent compose
 */
export async function removePermission(
  composeId: string,
  granteeType: "public" | "email",
  granteeEmail?: string,
): Promise<boolean> {
  const conditions = [
    eq(agentPermissions.agentComposeId, composeId),
    eq(agentPermissions.granteeType, granteeType),
  ];

  if (granteeType === "email" && granteeEmail) {
    conditions.push(eq(agentPermissions.granteeEmail, granteeEmail));
  }

  const result = await globalThis.services.db
    .delete(agentPermissions)
    .where(and(...conditions));

  return (result.rowCount ?? 0) > 0;
}

/**
 * List all permissions for an agent compose
 */
export async function listPermissions(composeId: string) {
  return globalThis.services.db
    .select()
    .from(agentPermissions)
    .where(eq(agentPermissions.agentComposeId, composeId))
    .orderBy(agentPermissions.createdAt);
}
