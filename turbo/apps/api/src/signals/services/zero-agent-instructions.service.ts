import { computed, type Computed } from "ccstate";
import { agentComposeApiContentSchema } from "@vm0/api-contracts/contracts/composes";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { getInstructionsFilename } from "@vm0/core/frameworks";
import { stripMetadataFrontmatter } from "@vm0/core/instructions-frontmatter";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadS3Buffer, downloadManifest } from "../external/s3";
import { env } from "../../lib/env";
import { extractFileFromTarGz } from "../../lib/tar";

interface AgentInstructionsResult {
  readonly content: string | null;
  readonly filename: string | null;
}

/**
 * Retrieve the instructions content for a zero agent.
 *
 * Looks up the agent by ID within the given org, locates the instructions
 * storage volume, and extracts the canonical instructions file from the
 * S3 archive. Returns null when the agent is not found.
 */
export function zeroAgentInstructions(
  orgId: string,
  agentId: string,
): Computed<Promise<AgentInstructionsResult | null>> {
  return computed(async (get): Promise<AgentInstructionsResult | null> => {
    const [compose] = await get(db$)
      .select({
        name: agentComposes.name,
        orgId: agentComposes.orgId,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(and(eq(agentComposes.orgId, orgId), eq(agentComposes.id, agentId)))
      .limit(1);

    if (!compose) {
      return null;
    }

    const parsed = agentComposeApiContentSchema.safeParse(compose.content);
    if (!parsed.success) {
      return { content: null, filename: null };
    }

    const agentKeys = Object.keys(parsed.data.agents);
    const firstKey = agentKeys[0];
    const agentDef = firstKey ? parsed.data.agents[firstKey] : undefined;
    const instructionsFilename =
      agentDef?.instructions ?? getInstructionsFilename(agentDef?.framework);

    const storageName = getInstructionsStorageName(compose.name);
    const [storage] = await get(db$)
      .select({
        headVersionId: storages.headVersionId,
      })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, compose.orgId),
          eq(storages.name, storageName),
          eq(storages.type, "volume"),
        ),
      )
      .limit(1);

    if (!storage?.headVersionId) {
      return { content: null, filename: instructionsFilename };
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    if (!version) {
      return { content: null, filename: instructionsFilename };
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifest = await get(downloadManifest(bucket, version.s3Key));
    const normalize = (p: string): string => {
      return p.replace(/^\.\//, "");
    };

    const canonicalFilename = getInstructionsFilename(agentDef?.framework);
    const instructionFile = manifest.files.find((f) => {
      return normalize(f.path) === normalize(canonicalFilename);
    });

    if (!instructionFile) {
      return { content: null, filename: instructionsFilename };
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await get(downloadS3Buffer(bucket, archiveKey));
    const rawContent = extractFileFromTarGz(
      archiveBuffer,
      instructionFile.path,
    );

    if (rawContent === null) {
      return { content: null, filename: instructionsFilename };
    }

    const hasLegacyBlocks =
      rawContent.includes("[AGENT_PROFILE]") ||
      rawContent.includes("<!-- ZERO_PROFILE");
    const content = hasLegacyBlocks
      ? stripMetadataFrontmatter(rawContent)
      : rawContent;

    return {
      content,
      filename: instructionsFilename,
    };
  });
}
