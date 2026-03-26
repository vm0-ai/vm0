import { eq, and, desc, inArray } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { zeroAgents } from "../../db/schema/zero-agent";
import { storages } from "../../db/schema/storage";
import { agentRuns } from "../../db/schema/agent-run";
import { getInstructionsStorageName } from "@vm0/core";
import { notFound, conflict } from "../errors";
import { canAccessCompose } from "../agent/compose-access";
import { listS3Objects, deleteS3Objects } from "../s3/s3-client";
import type { AgentComposeYaml } from "../../types/agent-compose";
import type { ComposeResponse, ComposeListItem } from "@vm0/core";

/**
 * Get a compose's orgId by compose ID.
 * Used by sandbox auth path where org context is unavailable.
 *
 * Throws notFound if compose doesn't exist.
 */
export async function getComposeOrgId(composeId: string): Promise<string> {
  const [result] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!result) throw notFound("Agent compose not found");
  return result.orgId;
}

/**
 * Get a compose by name within an org, returning the API response shape.
 * Returns null if not found.
 */
export async function getComposeByName(
  orgId: string,
  name: string,
): Promise<ComposeResponse | null> {
  const [result] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      createdAt: agentComposes.createdAt,
      updatedAt: agentComposes.updatedAt,
      content: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(and(eq(agentComposes.orgId, orgId), eq(agentComposes.name, name)))
    .limit(1);

  if (!result) return null;

  return {
    id: result.id,
    name: result.name,
    headVersionId: result.headVersionId,
    content: (result.content as AgentComposeYaml) ?? null,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  };
}

/**
 * Get a compose by ID with access check, returning the API response shape.
 *
 * Throws notFound if compose doesn't exist or caller lacks access.
 */
export async function getComposeById(
  composeId: string,
  userId: string,
  orgId: string,
): Promise<ComposeResponse> {
  const [result] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      orgId: agentComposes.orgId,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      createdAt: agentComposes.createdAt,
      updatedAt: agentComposes.updatedAt,
      content: agentComposeVersions.content,
    })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!result || !canAccessCompose(userId, orgId, result)) {
    throw notFound("Agent compose not found");
  }

  return {
    id: result.id,
    name: result.name,
    headVersionId: result.headVersionId,
    content: (result.content as AgentComposeYaml) ?? null,
    createdAt: result.createdAt.toISOString(),
    updatedAt: result.updatedAt.toISOString(),
  };
}

/**
 * Delete compose by ID with full cleanup. Caller is responsible for auth.
 * Checks for active runs, deletes cascade + S3 instructions storage.
 *
 * Throws conflict if compose has running/pending runs.
 */
export async function deleteComposeById(
  composeId: string,
  composeName: string,
  orgId: string,
): Promise<void> {
  const db = globalThis.services.db;

  // Check for running/pending runs
  const runningRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .where(
      and(
        eq(agentComposeVersions.composeId, composeId),
        inArray(agentRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);

  if (runningRuns.length > 0) {
    throw conflict("Cannot delete agent: agent is currently running");
  }

  // Delete agent (cascades handle related data)
  await db.delete(agentComposes).where(eq(agentComposes.id, composeId));

  // Clean up agent-instructions volume (DB + S3)
  const storageName = getInstructionsStorageName(composeName);
  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.name, storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);

  if (storage) {
    await db.delete(storages).where(eq(storages.id, storage.id));

    const bucketName = globalThis.services.env.R2_USER_STORAGES_BUCKET_NAME;
    const objects = await listS3Objects(bucketName, storage.s3Prefix);
    if (objects.length > 0) {
      await deleteS3Objects(
        bucketName,
        objects.map((o) => o.key),
      );
    }
  }
}

/**
 * Delete a compose by ID. Verifies ownership, then delegates to deleteComposeById.
 *
 * Throws notFound if compose doesn't exist or caller is not the owner.
 * Throws conflict if compose has running/pending runs.
 */
export async function deleteCompose(
  composeId: string,
  userId: string,
): Promise<void> {
  const db = globalThis.services.db;

  const [compose] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(
      and(eq(agentComposes.id, composeId), eq(agentComposes.userId, userId)),
    )
    .limit(1);

  if (!compose) {
    throw notFound("Agent not found");
  }

  await deleteComposeById(composeId, compose.name, compose.orgId);
}

/**
 * Update compose metadata (displayName, description, sound).
 * Verifies compose exists and caller has access.
 *
 * Throws notFound if compose doesn't exist or caller lacks access.
 */
export async function updateComposeMetadata(
  composeId: string,
  userId: string,
  orgId: string,
  body: {
    displayName?: string | null;
    description?: string | null;
    sound?: string | null;
  },
): Promise<void> {
  const db = globalThis.services.db;

  const [compose] = await db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      orgId: agentComposes.orgId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose || !canAccessCompose(userId, orgId, compose)) {
    throw notFound("Agent compose not found");
  }

  await db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId: compose.orgId,
      name: compose.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      sound: body.sound ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        ...(body.displayName !== undefined && {
          displayName: body.displayName,
        }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.sound !== undefined && { sound: body.sound }),
        updatedAt: new Date(),
      },
    });
}

/**
 * List all composes for an org with metadata from zero_agents.
 */
export async function listComposes(
  orgId: string,
): Promise<{ composes: ComposeListItem[] }> {
  const ownComposes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(eq(agentComposes.orgId, orgId))
    .orderBy(desc(agentComposes.updatedAt));

  const composes = ownComposes.map((c) => ({
    id: c.id,
    name: c.name,
    displayName: c.displayName ?? null,
    description: c.description ?? null,
    sound: c.sound ?? null,
    headVersionId: c.headVersionId,
    updatedAt: c.updatedAt.toISOString(),
  }));

  return { composes };
}
