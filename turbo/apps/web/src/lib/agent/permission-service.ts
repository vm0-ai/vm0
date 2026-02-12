import { eq, and, or, ne, desc } from "drizzle-orm";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentPermissions } from "../../db/schema/agent-permission";
import { scopes } from "../../db/schema/scope";
import { logger } from "../logger";

const log = logger("agent:permission");

/**
 * Check if a user can access an agent compose
 *
 * Access is granted if:
 * 1. User is the owner of the compose
 * 2. Compose is in a system scope (public)
 * 3. Compose has a 'public' permission entry
 * 4. User's email matches an 'email' permission entry
 */
export async function canAccessCompose(
  userId: string,
  userEmail: string,
  compose: { id: string; userId: string; scopeId: string },
): Promise<boolean> {
  // 1. Owner always has access
  if (compose.userId === userId) return true;

  // 2. Check scope and ACL in parallel (independent queries)
  const [scopeResult, permissionResult] = await Promise.all([
    globalThis.services.db
      .select()
      .from(scopes)
      .where(eq(scopes.id, compose.scopeId))
      .limit(1),
    globalThis.services.db
      .select()
      .from(agentPermissions)
      .where(
        and(
          eq(agentPermissions.agentComposeId, compose.id),
          or(
            eq(agentPermissions.granteeType, "public"),
            and(
              eq(agentPermissions.granteeType, "email"),
              eq(agentPermissions.granteeEmail, userEmail),
            ),
          ),
        ),
      )
      .limit(1),
  ]);

  // 3. System scope = public access
  if (scopeResult[0]?.type === "system") return true;

  // 4. Check ACL table result
  return !!permissionResult[0];
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

interface SharedAgent {
  id: string;
  name: string;
  headVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  scopeSlug: string;
}

/**
 * Fetch agents shared with a user via email permissions.
 * Excludes agents the user owns (to avoid duplicates).
 */
export async function getEmailSharedAgents(
  userId: string,
  userEmail: string,
  options?: { nameFilter?: string },
): Promise<SharedAgent[]> {
  const conditions = [
    eq(agentPermissions.granteeType, "email"),
    eq(agentPermissions.granteeEmail, userEmail),
    ne(agentComposes.userId, userId),
  ];

  if (options?.nameFilter) {
    conditions.push(eq(agentComposes.name, options.nameFilter));
  }

  return globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      createdAt: agentComposes.createdAt,
      updatedAt: agentComposes.updatedAt,
      scopeSlug: scopes.slug,
    })
    .from(agentPermissions)
    .innerJoin(
      agentComposes,
      eq(agentPermissions.agentComposeId, agentComposes.id),
    )
    .innerJoin(scopes, eq(agentComposes.scopeId, scopes.id))
    .where(and(...conditions))
    .orderBy(desc(agentComposes.createdAt));
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
