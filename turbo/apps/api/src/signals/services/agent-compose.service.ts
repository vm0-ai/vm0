import { command } from "ccstate";
import { createHash } from "node:crypto";
import {
  getConnectorEnvironmentMapping,
  getEligibleConnectorTypes,
} from "@vm0/connectors/connector-utils";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import {
  getInstructionsFilename,
  SUPPORTED_FRAMEWORKS,
} from "@vm0/core/frameworks";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

/**
 * Build canonical compose content for a zero agent. Pure function — same
 * inputs always yield the same output. Mirrors
 * apps/web/src/lib/zero/build-compose-content.ts so the version hash
 * computed here matches the existing web route behavior.
 */
function buildZeroAgentComposeContent(
  agentName: string,
): Record<string, unknown> {
  const eligibleConnectorTypes = getEligibleConnectorTypes();

  const environment: Record<string, string> = {
    ZERO_AGENT_ID: `\${{ vars.ZERO_AGENT_ID }}`,
    ZERO_TOKEN: `\${{ secrets.ZERO_TOKEN }}`,
  };

  for (const connector of eligibleConnectorTypes) {
    const parsed = connectorTypeSchema.safeParse(connector);
    if (!parsed.success) {
      continue;
    }
    const mapping = getConnectorEnvironmentMapping(parsed.data);
    for (const [envVar, valueRef] of Object.entries(mapping)) {
      if (envVar in environment) {
        continue;
      }
      if (valueRef.startsWith("$secrets.")) {
        environment[envVar] = `\${{ secrets.${envVar} }}`;
      } else if (valueRef.startsWith("$vars.")) {
        environment[envVar] = `\${{ vars.${envVar} }}`;
      }
    }
  }

  const agentDef: Record<string, unknown> = {
    framework: "claude-code",
    instructions: getInstructionsFilename("claude-code"),
    environment,
  };

  return {
    version: "1",
    agents: { [agentName]: agentDef },
  };
}

function instructionFilesForFramework(args: {
  readonly content: string;
  readonly framework?: string;
}): readonly { readonly path: string; readonly content: string }[] {
  const filenames = [
    getInstructionsFilename(args.framework),
    ...SUPPORTED_FRAMEWORKS.map((framework) => {
      return getInstructionsFilename(framework);
    }),
  ].filter((entry, index, all) => {
    return all.indexOf(entry) === index;
  });

  return filenames.map((path) => {
    return { path, content: args.content };
  });
}

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * SHA-256 of the canonical-JSON form of `content`. Mirrors
 * apps/web/src/lib/infra/agent-compose/content-hash.ts:computeComposeVersionId
 * so api and web produce the same hash for the same content during the
 * shadow-compare rollout window.
 */
function computeComposeVersionId(content: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortObjectKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Rebuild the agent's compose head if its current head version is stale.
 *
 * This is a focused subset of web's `serverSideCompose` helper. Two
 * branches that web's helper runs are dead code on this caller's path:
 *
 * 1. **Skip `extractAgentConfig` validation** (framework + agent-name regex).
 *    `agentName` comes from `agent_composes.name`, which was regex-validated
 *    at compose-creation time and stored normalized to lowercase. The
 *    `framework: "claude-code"` field is a hard-coded constant inside
 *    `buildComposeContent`. Both checks would always pass — re-running them
 *    would be defensive duplication.
 *
 * 2. **Skip the find-or-create branch on `agent_composes`.** Callers
 *    (e.g., the user-connectors PUT handler) SELECT the row by
 *    `(orgId, id)` and 404 if missing before calling here. We go straight
 *    to the version INSERT + head-pointer UPDATE.
 *
 * Like web, runs OUTSIDE any transaction the caller may be holding —
 * web's `serverSideCompose` is also called outside the user-connectors
 * DELETE+INSERT transaction. We mirror to preserve identical observable
 * behavior, including the same crash window: if recompose throws after
 * the caller's transaction commits, `agent_composes.head` stays stale
 * until the next mutation.
 */
export const recomposeAgentIfStale$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly agentComposeId: string;
      readonly agentName: string;
      readonly currentHeadVersionId: string | null;
    },
    signal: AbortSignal,
  ): Promise<{ recomposed: boolean; versionId: string }> => {
    const content = buildZeroAgentComposeContent(args.agentName);
    const versionId = computeComposeVersionId(content);
    if (versionId === args.currentHeadVersionId) {
      return { recomposed: false, versionId };
    }

    const writeDb = set(writeDb$);
    await writeDb
      .insert(agentComposeVersions)
      .values({
        id: versionId,
        composeId: args.agentComposeId,
        content,
        createdBy: args.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId, updatedAt: nowDate() })
      .where(eq(agentComposes.id, args.agentComposeId));
    signal.throwIfAborted();

    return { recomposed: true, versionId };
  },
);

export const createServerSideZeroAgentCompose$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly agentName: string;
      readonly instructions?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly composeId: string;
    readonly composeName: string;
    readonly versionId: string;
  }> => {
    const content = buildZeroAgentComposeContent(args.agentName);

    if (args.instructions !== undefined) {
      await set(
        uploadVolumeServerSide$,
        {
          orgId: args.orgId,
          storageName: getInstructionsStorageName(args.agentName.toLowerCase()),
          files: instructionFilesForFramework({
            content: args.instructions,
            framework: "claude-code",
          }),
        },
        signal,
      );
      signal.throwIfAborted();
    }

    const versionId = computeComposeVersionId(content);
    const writeDb = set(writeDb$);
    const [compose] = await writeDb
      .insert(agentComposes)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        name: args.agentName,
      })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();

    if (!compose) {
      throw new Error("Failed to create zero agent compose");
    }

    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId: compose.id,
      content,
      createdBy: args.userId,
    });
    signal.throwIfAborted();

    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId, updatedAt: nowDate() })
      .where(eq(agentComposes.id, compose.id));
    signal.throwIfAborted();

    return {
      composeId: compose.id,
      composeName: args.agentName,
      versionId,
    };
  },
);

export const serverSideZeroAgentCompose$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly agentComposeId: string;
      readonly agentName: string;
      readonly instructions?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly composeId: string;
    readonly composeName: string;
    readonly versionId: string;
  }> => {
    const content = buildZeroAgentComposeContent(args.agentName);

    if (args.instructions !== undefined) {
      await set(
        uploadVolumeServerSide$,
        {
          orgId: args.orgId,
          storageName: getInstructionsStorageName(args.agentName.toLowerCase()),
          files: instructionFilesForFramework({
            content: args.instructions,
            framework: "claude-code",
          }),
        },
        signal,
      );
      signal.throwIfAborted();
    }

    const versionId = computeComposeVersionId(content);
    const writeDb = set(writeDb$);

    await writeDb
      .insert(agentComposeVersions)
      .values({
        id: versionId,
        composeId: args.agentComposeId,
        content,
        createdBy: args.userId,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    await writeDb
      .update(agentComposes)
      .set({ headVersionId: versionId, updatedAt: nowDate() })
      .where(eq(agentComposes.id, args.agentComposeId));
    signal.throwIfAborted();

    return {
      composeId: args.agentComposeId,
      composeName: args.agentName,
      versionId,
    };
  },
);
