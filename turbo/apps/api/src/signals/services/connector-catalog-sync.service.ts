import { createHash } from "node:crypto";

import type {
  ConnectorCatalogSyncFailureCode,
  ConnectorCatalogSyncResponse,
  ConnectorCatalogSyncStatus,
} from "@vm0/api-contracts/contracts/cron";
import {
  connectorCatalogReleaseIdentities,
  connectorCatalogSyncState,
} from "@vm0/db/schema/connector-catalog";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { settle } from "../utils";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "./connector-catalog-artifacts/artifacts";
import {
  connectorCatalogArtifactFailureCode,
  loadConnectorCatalogActivePointer,
  loadConnectorCatalogCandidate,
  type ConnectorCatalogActivePointer,
  type ConnectorCatalogArtifactReader,
  type ConnectorCatalogReleaseIdentity,
  type ValidatedConnectorCatalogCandidate,
} from "./connector-catalog-artifacts/loader";

const log = logger("connector-catalog:sync");

interface ConnectorCatalogSource {
  readonly bucket: string;
  readonly sourceId: string;
}

interface SyncStateSnapshot {
  readonly revision: number;
  readonly activeCatalogVersion: string | null;
  readonly publicCatalog: string | null;
  readonly activatedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastAttemptOutcome: "accepted" | "unchanged" | "rejected" | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureCode: ConnectorCatalogSyncFailureCode | null;
  readonly activeIntegrityDigest: string | null;
}

interface StoredReleaseIdentity {
  readonly integrityDigest: string;
  readonly publicCatalogDigest: string;
  readonly privateCatalogDigest: string;
  readonly privateFirewallsDigest: string;
  readonly runnerFirewallsDigest: string;
}

type CandidateCommitResult = "accepted" | "rejected" | "retry";

class CandidateCommitRetry extends Error {}

function connectorCatalogSource(): ConnectorCatalogSource {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const authority = new URL(endpoint).origin;
  const sourceId = createHash("sha256")
    .update(authority)
    .update("\0")
    .update(bucket)
    .digest("hex");
  return { bucket, sourceId };
}

async function readSyncState(
  db: ReadonlyDb,
  sourceId: string,
): Promise<SyncStateSnapshot | undefined> {
  const [state] = await db
    .select({
      revision: connectorCatalogSyncState.revision,
      activeCatalogVersion: connectorCatalogSyncState.activeCatalogVersion,
      publicCatalog: connectorCatalogSyncState.publicCatalog,
      activatedAt: connectorCatalogSyncState.activatedAt,
      lastAttemptAt: connectorCatalogSyncState.lastAttemptAt,
      lastAttemptOutcome: connectorCatalogSyncState.lastAttemptOutcome,
      lastSuccessAt: connectorCatalogSyncState.lastSuccessAt,
      lastFailureCode: connectorCatalogSyncState.lastFailureCode,
      activeIntegrityDigest: connectorCatalogReleaseIdentities.integrityDigest,
    })
    .from(connectorCatalogSyncState)
    .leftJoin(
      connectorCatalogReleaseIdentities,
      and(
        eq(
          connectorCatalogReleaseIdentities.sourceId,
          connectorCatalogSyncState.sourceId,
        ),
        eq(
          connectorCatalogReleaseIdentities.schemaVersion,
          connectorCatalogSyncState.schemaVersion,
        ),
        eq(
          connectorCatalogReleaseIdentities.catalogVersion,
          connectorCatalogSyncState.activeCatalogVersion,
        ),
      ),
    )
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
      ),
    )
    .limit(1);
  return state;
}

async function readReleaseIdentity(
  db: ReadonlyDb,
  sourceId: string,
  catalogVersion: string,
): Promise<StoredReleaseIdentity | undefined> {
  const [identity] = await db
    .select({
      integrityDigest: connectorCatalogReleaseIdentities.integrityDigest,
      publicCatalogDigest:
        connectorCatalogReleaseIdentities.publicCatalogDigest,
      privateCatalogDigest:
        connectorCatalogReleaseIdentities.privateCatalogDigest,
      privateFirewallsDigest:
        connectorCatalogReleaseIdentities.privateFirewallsDigest,
      runnerFirewallsDigest:
        connectorCatalogReleaseIdentities.runnerFirewallsDigest,
    })
    .from(connectorCatalogReleaseIdentities)
    .where(
      and(
        eq(connectorCatalogReleaseIdentities.sourceId, sourceId),
        eq(
          connectorCatalogReleaseIdentities.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogReleaseIdentities.catalogVersion, catalogVersion),
      ),
    )
    .limit(1);
  return identity;
}

function statusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogSyncStatus {
  let active: ConnectorCatalogSyncStatus["active"] = null;
  if (state?.activeCatalogVersion) {
    if (!state.activatedAt || !state.activeIntegrityDigest) {
      throw new Error("Connector catalog active state is incomplete");
    }
    active = {
      catalogVersion: state.activeCatalogVersion,
      integrityDigest: state.activeIntegrityDigest,
      activatedAt: state.activatedAt.toISOString(),
    };
  }

  let lastAttempt: ConnectorCatalogSyncStatus["lastAttempt"] = null;
  if (state?.lastAttemptAt || state?.lastAttemptOutcome) {
    if (!state.lastAttemptAt || !state.lastAttemptOutcome) {
      throw new Error("Connector catalog attempt state is incomplete");
    }
    lastAttempt = {
      at: state.lastAttemptAt.toISOString(),
      outcome: state.lastAttemptOutcome,
      failureCode: state.lastFailureCode,
    };
  }

  return {
    state:
      active === null
        ? "never-synced"
        : state?.lastAttemptOutcome === "rejected"
          ? "stale"
          : "current",
    active,
    lastAttempt,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
  };
}

function pointerMatchesActiveState(
  pointer: ConnectorCatalogActivePointer,
  state: SyncStateSnapshot | undefined,
): boolean {
  if (!state) {
    return false;
  }
  return (
    pointer.catalogVersion === state.activeCatalogVersion &&
    pointer.integrityDigest === state.activeIntegrityDigest
  );
}

function pointerConflictsWithStoredIdentity(
  pointer: ConnectorCatalogActivePointer,
  identity: StoredReleaseIdentity | undefined,
): boolean {
  return (
    identity !== undefined &&
    pointer.integrityDigest !== identity.integrityDigest
  );
}

function storedIdentityMatches(
  stored: StoredReleaseIdentity,
  candidate: ConnectorCatalogReleaseIdentity,
): boolean {
  return (
    stored.integrityDigest === candidate.integrityDigest &&
    stored.publicCatalogDigest === candidate.publicCatalogDigest &&
    stored.privateCatalogDigest === candidate.privateCatalogDigest &&
    stored.privateFirewallsDigest === candidate.privateFirewallsDigest &&
    stored.runnerFirewallsDigest === candidate.runnerFirewallsDigest
  );
}

function classifySyncFailure(error: unknown): ConnectorCatalogSyncFailureCode {
  const artifactFailureCode = connectorCatalogArtifactFailureCode(error);
  if (artifactFailureCode) {
    return artifactFailureCode;
  }
  if (error instanceof S3ObjectSizeLimitError) {
    return "object-too-large";
  }
  return "source-unavailable";
}

async function recordRejectedAttempt(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly attemptedAt: Date;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
}): Promise<boolean> {
  if (!args.baseline) {
    const inserted = await args.db
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: args.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        revision: 1,
        lastAttemptAt: args.attemptedAt,
        lastAttemptOutcome: "rejected",
        lastFailureCode: args.failureCode,
      })
      .onConflictDoNothing()
      .returning({ sourceId: connectorCatalogSyncState.sourceId });
    return inserted.length === 1;
  }

  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: sql`${connectorCatalogSyncState.revision} + 1`,
      lastAttemptAt: args.attemptedAt,
      lastAttemptOutcome: "rejected",
      lastFailureCode: args.failureCode,
    })
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, args.sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogSyncState.revision, args.baseline.revision),
      ),
    )
    .returning({ sourceId: connectorCatalogSyncState.sourceId });
  return updated.length === 1;
}

async function recordUnchangedAttempt(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot;
  readonly attemptedAt: Date;
}): Promise<boolean> {
  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: sql`${connectorCatalogSyncState.revision} + 1`,
      lastAttemptAt: args.attemptedAt,
      lastAttemptOutcome: "unchanged",
      lastSuccessAt: args.attemptedAt,
      lastFailureCode: null,
    })
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, args.sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogSyncState.revision, args.baseline.revision),
      ),
    )
    .returning({ sourceId: connectorCatalogSyncState.sourceId });
  return updated.length === 1;
}

async function persistReleaseIdentity(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly identity: ConnectorCatalogReleaseIdentity;
  readonly attemptedAt: Date;
}): Promise<StoredReleaseIdentity> {
  const identity = args.identity;
  await args.db
    .insert(connectorCatalogReleaseIdentities)
    .values({
      sourceId: args.sourceId,
      schemaVersion: identity.schemaVersion,
      catalogVersion: identity.catalogVersion,
      integrityDigest: identity.integrityDigest,
      publicCatalogDigest: identity.publicCatalogDigest,
      privateCatalogDigest: identity.privateCatalogDigest,
      privateFirewallsDigest: identity.privateFirewallsDigest,
      runnerFirewallsDigest: identity.runnerFirewallsDigest,
      firstValidatedAt: args.attemptedAt,
    })
    .onConflictDoNothing();

  const stored = await readReleaseIdentity(
    args.db,
    args.sourceId,
    identity.catalogVersion,
  );
  if (!stored) {
    throw new Error("Connector catalog release identity was not persisted");
  }
  return stored;
}

async function activateCandidate(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly attemptedAt: Date;
}): Promise<void> {
  const stateValues = {
    activeCatalogVersion: args.candidate.identity.catalogVersion,
    publicCatalog: args.candidate.publicCatalogText,
    activatedAt: args.attemptedAt,
    lastAttemptAt: args.attemptedAt,
    lastAttemptOutcome: "accepted" as const,
    lastSuccessAt: args.attemptedAt,
    lastFailureCode: null,
  };
  if (!args.baseline) {
    const inserted = await args.db
      .insert(connectorCatalogSyncState)
      .values({
        sourceId: args.sourceId,
        schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        revision: 1,
        ...stateValues,
      })
      .onConflictDoNothing()
      .returning({ sourceId: connectorCatalogSyncState.sourceId });
    if (inserted.length === 0) {
      throw new CandidateCommitRetry();
    }
    return;
  }

  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: sql`${connectorCatalogSyncState.revision} + 1`,
      ...stateValues,
    })
    .where(
      and(
        eq(connectorCatalogSyncState.sourceId, args.sourceId),
        eq(
          connectorCatalogSyncState.schemaVersion,
          SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
        ),
        eq(connectorCatalogSyncState.revision, args.baseline.revision),
      ),
    )
    .returning({ sourceId: connectorCatalogSyncState.sourceId });
  if (updated.length === 0) {
    throw new CandidateCommitRetry();
  }
}

async function commitCandidate(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly attemptedAt: Date;
}): Promise<CandidateCommitResult> {
  const result = await settle(
    args.db.transaction(async (tx) => {
      const stored = await persistReleaseIdentity({
        db: tx,
        sourceId: args.sourceId,
        identity: args.candidate.identity,
        attemptedAt: args.attemptedAt,
      });
      if (!storedIdentityMatches(stored, args.candidate.identity)) {
        const committed = await recordRejectedAttempt({
          db: tx,
          sourceId: args.sourceId,
          baseline: args.baseline,
          attemptedAt: args.attemptedAt,
          failureCode: "conflicting-release",
        });
        if (!committed) {
          throw new CandidateCommitRetry();
        }
        return "rejected";
      }
      await activateCandidate({ ...args, db: tx });
      return "accepted";
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof CandidateCommitRetry) {
    return "retry";
  }
  throw result.error;
}

async function responseFromState(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly outcome: ConnectorCatalogSyncResponse["outcome"];
}): Promise<ConnectorCatalogSyncResponse> {
  const state = await readSyncState(args.db, args.sourceId);
  return {
    outcome: args.outcome,
    ...statusFromState(state),
  };
}

async function rejectCandidate(args: {
  readonly db: Db;
  readonly source: ConnectorCatalogSource;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
}): Promise<ConnectorCatalogSyncResponse | undefined> {
  const committed = await recordRejectedAttempt({
    db: args.db,
    sourceId: args.source.sourceId,
    baseline: args.baseline,
    attemptedAt: nowDate(),
    failureCode: args.failureCode,
  });
  if (!committed) {
    return undefined;
  }

  log.warn("Connector catalog candidate rejected", {
    sourceId: args.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    failureCode: args.failureCode,
    retainedActiveSnapshot:
      args.baseline !== undefined &&
      args.baseline.activeCatalogVersion !== null,
  });
  return await responseFromState({
    db: args.db,
    sourceId: args.source.sourceId,
    outcome: "rejected",
  });
}

interface ConnectorCatalogSyncRuntime {
  readonly db: Db;
  readonly reader: ConnectorCatalogArtifactReader;
  readonly source: ConnectorCatalogSource;
  readonly signal: AbortSignal;
}

type SyncAttemptResult =
  | { readonly kind: "retry" }
  | {
      readonly kind: "complete";
      readonly response: ConnectorCatalogSyncResponse;
    };

type SyncLoadResult<T> =
  | SyncAttemptResult
  | { readonly kind: "loaded"; readonly value: T };

async function rejectSyncAttempt(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  failureCode: ConnectorCatalogSyncFailureCode,
): Promise<SyncAttemptResult> {
  const response = await rejectCandidate({
    db: runtime.db,
    source: runtime.source,
    baseline,
    failureCode,
  });
  runtime.signal.throwIfAborted();
  return response ? { kind: "complete", response } : { kind: "retry" };
}

async function loadPointerForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
): Promise<SyncLoadResult<ConnectorCatalogActivePointer>> {
  const result = await settle(
    loadConnectorCatalogActivePointer(runtime.reader),
    runtime.signal,
  );
  runtime.signal.throwIfAborted();
  if (!result.ok) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(result.error),
    );
  }
  return { kind: "loaded", value: result.value };
}

async function loadCandidateForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  pointer: ConnectorCatalogActivePointer,
): Promise<SyncLoadResult<ValidatedConnectorCatalogCandidate>> {
  const result = await settle(
    loadConnectorCatalogCandidate({ reader: runtime.reader, pointer }),
    runtime.signal,
  );
  runtime.signal.throwIfAborted();
  if (!result.ok) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(result.error),
    );
  }
  return { kind: "loaded", value: result.value };
}

async function completeUnchangedSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot,
): Promise<SyncAttemptResult> {
  const committed = await recordUnchangedAttempt({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    baseline,
    attemptedAt: nowDate(),
  });
  runtime.signal.throwIfAborted();
  if (!committed) {
    return { kind: "retry" };
  }
  const response = await responseFromState({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    outcome: "unchanged",
  });
  runtime.signal.throwIfAborted();
  return { kind: "complete", response };
}

async function commitValidatedCandidate(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  candidate: ValidatedConnectorCatalogCandidate,
): Promise<SyncAttemptResult> {
  const outcome = await commitCandidate({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    baseline,
    candidate,
    attemptedAt: nowDate(),
  });
  runtime.signal.throwIfAborted();
  if (outcome === "retry") {
    return { kind: "retry" };
  }
  if (outcome === "rejected") {
    log.warn("Connector catalog candidate rejected", {
      sourceId: runtime.source.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      failureCode: "conflicting-release",
      retainedActiveSnapshot:
        baseline !== undefined && baseline.activeCatalogVersion !== null,
    });
  } else {
    log.debug("Connector catalog sync completed", {
      sourceId: runtime.source.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      catalogVersion: candidate.identity.catalogVersion,
      integrityDigest: candidate.identity.integrityDigest,
      outcome,
    });
  }
  const response = await responseFromState({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    outcome,
  });
  runtime.signal.throwIfAborted();
  return { kind: "complete", response };
}

async function syncConnectorCatalogAttempt(
  runtime: ConnectorCatalogSyncRuntime,
): Promise<SyncAttemptResult> {
  const baseline = await readSyncState(runtime.db, runtime.source.sourceId);
  runtime.signal.throwIfAborted();
  const pointerResult = await loadPointerForSync(runtime, baseline);
  if (pointerResult.kind !== "loaded") {
    return pointerResult;
  }
  const pointer = pointerResult.value;
  if (pointerMatchesActiveState(pointer, baseline)) {
    if (!baseline) {
      throw new Error("Connector catalog active state disappeared");
    }
    return await completeUnchangedSync(runtime, baseline);
  }

  const historicalIdentity = await readReleaseIdentity(
    runtime.db,
    runtime.source.sourceId,
    pointer.catalogVersion,
  );
  runtime.signal.throwIfAborted();
  if (pointerConflictsWithStoredIdentity(pointer, historicalIdentity)) {
    return await rejectSyncAttempt(runtime, baseline, "conflicting-release");
  }

  const candidateResult = await loadCandidateForSync(
    runtime,
    baseline,
    pointer,
  );
  if (candidateResult.kind !== "loaded") {
    return candidateResult;
  }
  return await commitValidatedCandidate(
    runtime,
    baseline,
    candidateResult.value,
  );
}

export const connectorCatalogStatus$ = command(
  async ({ get }, signal: AbortSignal): Promise<ConnectorCatalogSyncStatus> => {
    const source = connectorCatalogSource();
    const state = await readSyncState(get(db$), source.sourceId);
    signal.throwIfAborted();
    return statusFromState(state);
  },
);

export const syncConnectorCatalog$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogSyncResponse> => {
    const source = connectorCatalogSource();
    const runtime: ConnectorCatalogSyncRuntime = {
      db: set(writeDb$),
      source,
      signal,
      reader: {
        readArtifact: async (key, maxBytes) => {
          const bytes = await get(
            downloadS3BufferWithMaxBytes(source.bucket, key, maxBytes),
          );
          signal.throwIfAborted();
          return bytes;
        },
      },
    };

    while (true) {
      signal.throwIfAborted();
      const result = await syncConnectorCatalogAttempt(runtime);
      signal.throwIfAborted();
      if (result.kind === "retry") {
        continue;
      }
      return result.response;
    }
  },
);
