import { eq, and, inArray } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { storages } from "@vm0/db/schema/storage";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { ComposeResponse } from "@vm0/api-contracts/contracts/composes";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { notFound, conflict } from "@vm0/api-services/errors";
import { canAccessCompose } from "../agent/compose-access";
import { listS3Objects, deleteS3Objects } from "../s3/s3-client";
import type { AgentComposeYaml } from "./types";

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
async function deleteComposeById(
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

  // Delete all runs for this agent's compose versions.
  // Downstream tables (events, callbacks, telemetry, checkpoints, etc.)
  // cascade-delete automatically. usageEvent.runId is SET NULL to
  // preserve billing records.
  const versionIds = await db
    .select({ id: agentComposeVersions.id })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, composeId));

  if (versionIds.length > 0) {
    await db.delete(agentRuns).where(
      inArray(
        agentRuns.agentComposeVersionId,
        versionIds.map((v) => {
          return v.id;
        }),
      ),
    );
  }

  // Delete agent (cascades handle compose versions, schedules, etc.)
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
        objects.map((o) => {
          return o.key;
        }),
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
