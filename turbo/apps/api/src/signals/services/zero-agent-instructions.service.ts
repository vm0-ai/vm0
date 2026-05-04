import { computed, type Computed } from "ccstate";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import { getInstructionsFilename } from "@vm0/core/frameworks";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
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
    const [agentRow] = await get(db$)
      .select({
        name: agentComposes.name,
      })
      .from(zeroAgents)
      .innerJoin(agentComposes, eq(zeroAgents.id, agentComposes.id))
      .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.id, agentId)))
      .limit(1);

    if (!agentRow) {
      return null;
    }

    const storageName = getInstructionsStorageName(agentRow.name);
    const [storage] = await get(db$)
      .select({
        headVersionId: storages.headVersionId,
      })
      .from(storages)
      .where(and(eq(storages.orgId, orgId), eq(storages.name, storageName)))
      .limit(1);

    if (!storage?.headVersionId) {
      return { content: null, filename: null };
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    if (!version) {
      return { content: null, filename: null };
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return { content: null, filename: null };
    }

    // Download the manifest to discover the instructions file
    const manifest = await get(downloadManifest(bucket, version.s3Key));
    const normalize = (p: string): string => {
      return p.replace(/^\.\//, "");
    };

    // Try the canonical filename for each supported framework
    const canonicalFilenames = [
      getInstructionsFilename("claude-code"),
      getInstructionsFilename("codex"),
    ];

    let instructionPath: string | undefined;
    for (const canonical of canonicalFilenames) {
      const found = manifest.files.find((f) => {
        return normalize(f.path) === canonical;
      });
      if (found) {
        instructionPath = found.path;
        break;
      }
    }

    // Also check for "./CANONICAL" prefixed paths
    if (!instructionPath) {
      for (const canonical of canonicalFilenames) {
        const found = manifest.files.find((f) => {
          return f.path === `./${canonical}`;
        });
        if (found) {
          instructionPath = found.path;
          break;
        }
      }
    }

    if (!instructionPath) {
      return { content: null, filename: null };
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await get(downloadS3Buffer(bucket, archiveKey));
    const content = extractFileFromTarGz(archiveBuffer, instructionPath);

    return {
      content,
      filename: normalize(instructionPath),
    };
  });
}
