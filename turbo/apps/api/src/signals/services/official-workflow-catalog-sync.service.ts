import type {
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowArtifactReference,
  OfficialWorkflowCatalogDiagnostic,
  OfficialWorkflowCatalogReleasePayload,
  OfficialWorkflowCatalogSyncResponse,
  OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  getOfficialWorkflowDefinitionStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
  readAcceptedOfficialWorkflowCatalog,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  canonicalJsonString,
  OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
  officialWorkflowFingerprint,
  validateOfficialWorkflowCatalog,
  type ValidatedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-validation.service";
import { OFFICIAL_WORKFLOW_SOURCE_CATALOG } from "./official-workflow-catalog-source";
import {
  commitPreparedVolumeServerSide,
  prepareVolumeServerSide$,
  type PrepareVolumeServerSideInput,
  type PreparedServerSideVolume,
} from "./storage-volume-publication.service";

const CATALOG_ACTIVATION_LOCK = "official-workflow-catalog-activation";

interface PreparedOfficialWorkflowDefinition {
  readonly definition: OfficialWorkflowDefinitionRevisionPayload;
  readonly volume: PreparedServerSideVolume;
  readonly artifact: OfficialWorkflowArtifactReference;
}

type CandidateReleaseResult =
  | {
      readonly kind: "valid";
      readonly payload: OfficialWorkflowCatalogReleasePayload;
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    };

class OfficialWorkflowCatalogRegistrationError extends Error {
  readonly definitionName: string | undefined;

  constructor(definitionName?: string, cause?: unknown) {
    super(
      "Official Workflow catalog registration failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "OfficialWorkflowCatalogRegistrationError";
    this.definitionName = definitionName;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function releaseDiagnostics(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: AcceptedOfficialWorkflowCatalog | null,
): readonly OfficialWorkflowCatalogDiagnostic[] {
  const diagnostics: OfficialWorkflowCatalogDiagnostic[] = [];
  const sourceByName = new Map(
    catalog.source.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }),
  );
  for (const previousDefinition of previous?.payload.definitions ?? []) {
    if (!sourceByName.has(previousDefinition.name)) {
      diagnostics.push({
        code: "missing-released-definition",
        path: ["definitions"],
        definitionName: previousDefinition.name,
      });
    }
  }
  const previousNames = new Set(
    previous?.payload.definitions.map((definition) => {
      return definition.name;
    }) ?? [],
  );
  for (const [index, definition] of catalog.source.definitions.entries()) {
    if (
      definition.lifecycle === "retired" &&
      !previousNames.has(definition.name)
    ) {
      diagnostics.push({
        code: "unknown-retired-definition",
        path: ["definitions", index, "lifecycle"],
        definitionName: definition.name,
      });
    }
  }
  return diagnostics;
}

function buildCandidateRelease(
  catalog: ValidatedOfficialWorkflowCatalog,
  previous: AcceptedOfficialWorkflowCatalog | null,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
): CandidateReleaseResult {
  const diagnostics = releaseDiagnostics(catalog, previous);
  if (diagnostics.length > 0) {
    return { kind: "invalid", diagnostics };
  }
  const previousByName = new Map(
    previous?.payload.definitions.map((definition) => {
      return [definition.name, definition] as const;
    }) ?? [],
  );
  const definitions: OfficialWorkflowAcceptedDefinition[] = [];
  for (const sourceDefinition of catalog.source.definitions) {
    const previousDefinition = previousByName.get(sourceDefinition.name);
    if (sourceDefinition.lifecycle === "retired") {
      if (!previousDefinition) {
        throw new OfficialWorkflowCatalogRegistrationError(
          sourceDefinition.name,
        );
      }
      definitions.push({
        ...previousDefinition,
        lifecycle: "retired",
        presentation: sourceDefinition.presentation,
      });
      continue;
    }
    const prepared = preparedByName.get(sourceDefinition.name);
    if (!prepared) {
      throw new OfficialWorkflowCatalogRegistrationError(sourceDefinition.name);
    }
    const releasedBlueprintKeys = new Set(
      previousDefinition?.releasedBlueprintKeys ?? [],
    );
    for (const blueprint of prepared.definition.blueprints) {
      releasedBlueprintKeys.add(blueprint.key);
    }
    definitions.push({
      name: sourceDefinition.name,
      lifecycle: "active",
      revision: prepared.definition.revision,
      artifact: prepared.artifact,
      blueprints: prepared.definition.blueprints,
      releasedBlueprintKeys: [...releasedBlueprintKeys].sort(compareStrings),
      presentation: sourceDefinition.presentation,
    });
  }
  return {
    kind: "valid",
    payload: {
      schemaVersion: catalog.source.schemaVersion,
      definitions: definitions.sort((left, right) => {
        return compareStrings(left.name, right.name);
      }),
    },
  };
}

async function prepareDefinitions(
  prepareVolume: (
    input: PrepareVolumeServerSideInput,
    signal: AbortSignal,
  ) => Promise<PreparedServerSideVolume>,
  catalog: ValidatedOfficialWorkflowCatalog,
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "prepared";
      readonly definitions: ReadonlyMap<
        string,
        PreparedOfficialWorkflowDefinition
      >;
    }
  | {
      readonly kind: "rejected";
      readonly diagnostics: readonly OfficialWorkflowCatalogDiagnostic[];
    }
> {
  const preparedByName = new Map<string, PreparedOfficialWorkflowDefinition>();
  for (const sourceDefinition of catalog.source.definitions) {
    if (sourceDefinition.lifecycle === "retired") {
      continue;
    }
    const validated = catalog.activeDefinitions.get(sourceDefinition.name);
    if (!validated) {
      throw new OfficialWorkflowCatalogRegistrationError(sourceDefinition.name);
    }
    const storageName = getOfficialWorkflowDefinitionStorageName(
      sourceDefinition.name,
    );
    const volumeResult = await settle(
      prepareVolume(
        {
          orgId: SYSTEM_ORG_ID,
          storageName,
          files: [
            {
              path: "SKILL.md",
              content: synthesizeWorkflowSkillMd({
                name: sourceDefinition.name,
                description: validated.revisionPayload.workflow.description,
                instruction: validated.revisionPayload.workflow.instruction,
              }),
            },
            ...validated.revisionPayload.workflow.files,
            {
              path: OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH,
              content: `${canonicalJsonString(validated.revisionPayload)}\n`,
            },
          ],
        },
        signal,
      ),
      signal,
    );
    if (!volumeResult.ok) {
      return {
        kind: "rejected",
        diagnostics: [
          {
            code: "artifact-preparation-failed",
            path: ["definitions"],
            definitionName: sourceDefinition.name,
          },
        ],
      };
    }
    const volume = volumeResult.value;
    preparedByName.set(sourceDefinition.name, {
      definition: validated.revisionPayload,
      volume,
      artifact: {
        storageName,
        storageId: volume.version.storageId,
        storageVersion: volume.version.versionId,
      },
    });
  }
  return { kind: "prepared", definitions: preparedByName };
}

async function assertPreparedStorageIdentity(
  db: Db,
  prepared: PreparedOfficialWorkflowDefinition,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db
    .select({
      storageId: storages.id,
      storageVersion: storageVersions.id,
    })
    .from(storages)
    .leftJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, prepared.artifact.storageVersion),
      ),
    )
    .where(
      and(
        eq(storages.id, prepared.artifact.storageId),
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, prepared.artifact.storageName),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row || row.storageId !== prepared.artifact.storageId) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
  if (
    row.storageVersion !== null &&
    row.storageVersion !== prepared.artifact.storageVersion
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function persistDefinitionRevision(
  db: Db,
  prepared: PreparedOfficialWorkflowDefinition,
  signal: AbortSignal,
): Promise<void> {
  await db
    .insert(officialWorkflowDefinitionRevisions)
    .values({
      definitionName: prepared.definition.name,
      revision: prepared.definition.revision,
      payload: prepared.definition,
      storageName: prepared.artifact.storageName,
      storageId: prepared.artifact.storageId,
      storageVersion: prepared.artifact.storageVersion,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const [stored] = await db
    .select({
      payload: officialWorkflowDefinitionRevisions.payload,
      storageName: officialWorkflowDefinitionRevisions.storageName,
      storageId: officialWorkflowDefinitionRevisions.storageId,
      storageVersion: officialWorkflowDefinitionRevisions.storageVersion,
    })
    .from(officialWorkflowDefinitionRevisions)
    .where(
      and(
        eq(
          officialWorkflowDefinitionRevisions.definitionName,
          prepared.definition.name,
        ),
        eq(
          officialWorkflowDefinitionRevisions.revision,
          prepared.definition.revision,
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (
    !stored ||
    canonicalJsonString(stored.payload) !==
      canonicalJsonString(prepared.definition) ||
    stored.storageName !== prepared.artifact.storageName ||
    stored.storageId !== prepared.artifact.storageId ||
    stored.storageVersion !== prepared.artifact.storageVersion
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function persistCatalogRelease(
  db: Db,
  args: {
    readonly releaseId: string;
    readonly payload: OfficialWorkflowCatalogReleasePayload;
  },
  signal: AbortSignal,
): Promise<void> {
  await db
    .insert(officialWorkflowCatalogReleases)
    .values({ id: args.releaseId, payload: args.payload })
    .onConflictDoNothing();
  signal.throwIfAborted();
  const [stored] = await db
    .select({ payload: officialWorkflowCatalogReleases.payload })
    .from(officialWorkflowCatalogReleases)
    .where(eq(officialWorkflowCatalogReleases.id, args.releaseId))
    .limit(1);
  signal.throwIfAborted();
  if (
    !stored ||
    canonicalJsonString(stored.payload) !== canonicalJsonString(args.payload)
  ) {
    throw new OfficialWorkflowCatalogRegistrationError();
  }
}

async function activateCandidate(
  db: Db,
  catalog: ValidatedOfficialWorkflowCatalog,
  preparedByName: ReadonlyMap<string, PreparedOfficialWorkflowDefinition>,
  signal: AbortSignal,
): Promise<OfficialWorkflowCatalogSyncResponse> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${CATALOG_ACTIVATION_LOCK}))`,
    );
    signal.throwIfAborted();
    const current = await readAcceptedOfficialWorkflowCatalog(tx, signal);
    const candidate = buildCandidateRelease(catalog, current, preparedByName);
    if (candidate.kind === "invalid") {
      return {
        outcome: "rejected" as const,
        releaseId: current?.releaseId ?? null,
        diagnostics: [...candidate.diagnostics],
      };
    }
    const releaseId = officialWorkflowFingerprint(candidate.payload);
    if (current?.releaseId === releaseId) {
      return {
        outcome: "unchanged" as const,
        releaseId,
        diagnostics: [],
      };
    }
    for (const prepared of preparedByName.values()) {
      const registration = await settle(
        (async () => {
          await assertPreparedStorageIdentity(tx, prepared, signal);
          await commitPreparedVolumeServerSide(
            { db: tx, volume: prepared.volume },
            signal,
          );
          await persistDefinitionRevision(tx, prepared, signal);
        })(),
        signal,
      );
      if (!registration.ok) {
        throw new OfficialWorkflowCatalogRegistrationError(
          prepared.definition.name,
          registration.error,
        );
      }
    }
    await persistCatalogRelease(
      tx,
      { releaseId, payload: candidate.payload },
      signal,
    );
    await tx
      .insert(officialWorkflowCatalogState)
      .values({
        authority: OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
        acceptedReleaseId: releaseId,
        updatedAt: nowDate(),
      })
      .onConflictDoUpdate({
        target: officialWorkflowCatalogState.authority,
        set: { acceptedReleaseId: releaseId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
    return {
      outcome: "accepted" as const,
      releaseId,
      diagnostics: [],
    };
  });
}

export function createOfficialWorkflowCatalogSyncCommand(candidate: unknown) {
  return command(
    async (
      { set },
      signal: AbortSignal,
    ): Promise<OfficialWorkflowCatalogSyncResponse> => {
      const writeDb = set(writeDb$);
      const current = await readAcceptedOfficialWorkflowCatalog(
        writeDb,
        signal,
      );
      const validation = validateOfficialWorkflowCatalog(candidate);
      if (validation.kind === "invalid") {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...validation.diagnostics],
        };
      }
      const transitionDiagnostics = releaseDiagnostics(
        validation.catalog,
        current,
      );
      if (transitionDiagnostics.length > 0) {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...transitionDiagnostics],
        };
      }
      const preparation = await prepareDefinitions(
        async (input, prepareSignal) => {
          return await set(prepareVolumeServerSide$, input, prepareSignal);
        },
        validation.catalog,
        signal,
      );
      if (preparation.kind === "rejected") {
        return {
          outcome: "rejected",
          releaseId: current?.releaseId ?? null,
          diagnostics: [...preparation.diagnostics],
        };
      }
      const activation = await settle(
        activateCandidate(
          writeDb,
          validation.catalog,
          preparation.definitions,
          signal,
        ),
        signal,
      );
      if (!activation.ok) {
        const definitionName =
          activation.error instanceof OfficialWorkflowCatalogRegistrationError
            ? activation.error.definitionName
            : undefined;
        return {
          outcome: "rejected",
          releaseId:
            (await readAcceptedOfficialWorkflowCatalog(writeDb, signal))
              ?.releaseId ?? null,
          diagnostics: [
            {
              code: "artifact-registration-failed",
              path: ["definitions"],
              ...(definitionName === undefined ? {} : { definitionName }),
            },
          ],
        };
      }
      return activation.value;
    },
  );
}

export const syncOfficialWorkflowCatalog$ =
  createOfficialWorkflowCatalogSyncCommand(OFFICIAL_WORKFLOW_SOURCE_CATALOG);
