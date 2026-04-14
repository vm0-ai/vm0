import { and, eq } from "drizzle-orm";
import type { RawPermissionPolicies } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { composeJobs } from "../../db/schema/compose-job";
import { uniqueId } from "../test-helpers";

/**
 * @why-db-direct Creates compose + zero_agents WITHOUT a version — API always
 * creates a version. Tests that need a compose with a specific userId/orgId
 * outside of Clerk auth context (e.g., backfill scripts).
 */
export async function seedTestCompose(opts: {
  userId: string;
  name: string;
  orgId: string;
}): Promise<{ composeId: string; agentId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: opts.userId,
      name: opts.name,
      orgId: opts.orgId,
    })
    .returning({ id: agentComposes.id });
  if (!row) {
    throw new Error("Failed to seed agent compose");
  }

  // Ensure a matching zero_agents row exists (id = composeId after PK refactor)
  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      id: row.id,
      orgId: opts.orgId,
      owner: opts.userId,
      name: opts.name,
    })
    .onConflictDoNothing();

  return { composeId: row.id, agentId: row.id };
}

/**
 * @why-db-direct Creates compose WITHOUT zero_agents row — API always creates
 * both. Tests "agent not found" scenarios where getWorkspaceAgent() returns
 * undefined despite compose FK being satisfied.
 */
export async function seedOrphanCompose(opts: {
  userId: string;
  name: string;
  orgId: string;
}): Promise<{ composeId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: opts.userId,
      name: opts.name,
      orgId: opts.orgId,
    })
    .returning({ id: agentComposes.id });
  if (!row) {
    throw new Error("Failed to seed orphan agent compose");
  }
  return { composeId: row.id };
}

/**
 * @why-db-direct Sets HEAD to an arbitrary version — API always sets HEAD to
 * the latest created version. Tests stale-version handling in recompose flows.
 */
export async function setComposeHeadVersion(
  composeId: string,
  headVersionId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Sets HEAD to null — API never creates a versionless compose.
 * Tests pre-run failure when no version exists (e.g., executeSchedule).
 */
export async function clearComposeHeadVersion(
  composeId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Transfers compose between orgs — no API for org transfer.
 * Tests org-scoped installations for composes created in other orgs.
 */
export async function updateAgentComposeOrg(
  composeId: string,
  orgId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ orgId })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Direct compose_jobs insert — compose jobs are created by
 * internal pipeline, not user API. Tests compose job cleanup on deletion.
 */
export async function insertTestComposeJob(params: {
  userId: string;
  status?: string;
  githubUrl?: string;
}): Promise<{ id: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(composeJobs)
    .values({
      userId: params.userId,
      status: params.status ?? "completed",
      githubUrl: params.githubUrl ?? "https://github.com/test/repo",
    })
    .returning({ id: composeJobs.id });
  return row!;
}

/**
 * @why-db-direct Upserts zero_agents with permissionPolicies —
 * permissionPolicies is not settable via any API route. Tests agent
 * permission policy enforcement.
 */
export async function createTestZeroAgent(
  orgId: string,
  name: string,
  metadata: {
    displayName?: string;
    description?: string;
    sound?: string;
    permissionPolicies?: RawPermissionPolicies;
  },
): Promise<void> {
  initServices();

  // Resolve composeId and userId from compose table (zero_agents.id = composeId)
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, userId: agentComposes.userId })
    .from(agentComposes)
    .where(and(eq(agentComposes.orgId, orgId), eq(agentComposes.name, name)))
    .limit(1);

  if (!compose) {
    throw new Error(`Compose not found for org=${orgId} name=${name}`);
  }

  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId,
      owner: compose.userId,
      name,
      displayName: metadata.displayName ?? null,
      description: metadata.description ?? null,
      sound: metadata.sound ?? null,
      permissionPolicies: metadata.permissionPolicies ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        displayName: metadata.displayName ?? null,
        description: metadata.description ?? null,
        sound: metadata.sound ?? null,
        permissionPolicies: metadata.permissionPolicies ?? null,
      },
    });
}

/**
 * @why-db-direct Creates version with arbitrary non-content-hashed ID —
 * API uses content-addressed versioning. Internal helper for session creation.
 */
export async function createTestComposeVersion(
  composeId: string,
  userId: string,
): Promise<string> {
  initServices();
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
    createdBy: userId,
  });
  // Update compose to point to this version
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  return versionId;
}

/**
 * @why-db-direct Deletes compose bypassing running-run check that API
 * enforces. Tests compose deletion in cleanup flows.
 */
export async function deleteTestCompose(composeId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(agentComposes)
    .where(eq(agentComposes.id, composeId));
}
