import { createHash } from "node:crypto";

import type {
  ConnectorCatalogSyncFailureCode,
  ConnectorCatalogSyncResponse,
  ConnectorCatalogSyncStatus,
} from "@vm0/api-contracts/contracts/cron";
import {
  connectorCatalogActiveSnapshot,
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
  downloadS3BufferWithMaxBytesIfChanged,
  S3ObjectSizeLimitError,
  type ConditionalS3BufferDownload,
} from "../external/s3";
import { safeSync, safeUrlParse, settle } from "../utils";
import {
  CONNECTOR_CATALOG_ACTIVE_KEY,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "./connector-catalog-artifacts/artifacts";
import {
  CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
  connectorCatalogArtifactFailureCode,
  loadConnectorCatalogCandidate,
  parseConnectorCatalogActivePointer,
  type ConnectorCatalogActivePointer,
  type ConnectorCatalogArtifactReader,
  type ValidatedConnectorCatalogCandidate,
} from "./connector-catalog-artifacts/loader";
import {
  connectorCatalogSkillFailure,
  prepareConnectorCatalogSkills,
  registerPreparedConnectorCatalogSkills,
  type ConnectorCatalogSkillFailure,
  type PreparedConnectorSkillRegistration,
} from "./connector-catalog-skill-registration.service";

const log = logger("connector-catalog:sync");

interface ConnectorCatalogSource {
  readonly bucket: string;
  readonly sourceId: string;
}

type ConnectorCatalogRawSyncStatus = Omit<
  ConnectorCatalogSyncStatus,
  "filtering" | "credentialStorage"
>;
type ConnectorCatalogRawSyncResponse = Omit<
  ConnectorCatalogSyncResponse,
  "filtering" | "credentialStorage"
>;

interface SyncStateSnapshot {
  readonly revision: number;
  readonly lastObservedCatalogVersion: string | null;
  readonly lastObservedIntegrityDigest: string | null;
  readonly lastObservedPointerEtag: string | null;
  readonly lastAttemptAt: Date | null;
  readonly lastAttemptOutcome: "accepted" | "unchanged" | "rejected" | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureCode: ConnectorCatalogSyncFailureCode | null;
  readonly lastRejectedCatalogVersion: string | null;
  readonly lastRejectedIntegrityDigest: string | null;
  readonly lastRejectedPointerEtag: string | null;
  readonly lastRejectedFailureCode: ConnectorCatalogSyncFailureCode | null;
  readonly activeCatalogVersion: string | null;
  readonly activeIntegrityDigest: string | null;
  readonly activatedAt: Date | null;
}

interface PointerObservation {
  readonly pointer: ConnectorCatalogActivePointer | null;
  readonly etag: string | null;
}

interface RejectedCandidate {
  readonly pointer: ConnectorCatalogActivePointer | null;
  readonly pointerEtag: string | null;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
}

type CandidateCommitResult =
  | "accepted"
  | "retry"
  | {
      readonly kind: "rejected";
      readonly failure: ConnectorCatalogSkillFailure;
    };

class CandidateCommitRetry extends Error {}

class ConnectorCatalogPersistenceError extends Error {
  constructor() {
    super("Connector catalog snapshot persistence failed");
    this.name = "ConnectorCatalogPersistenceError";
  }
}

export function connectorCatalogSource(): ConnectorCatalogSource {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const endpointUrl = safeUrlParse(endpoint);
  if (
    endpointUrl === undefined ||
    (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:")
  ) {
    throw new Error("Connector catalog source endpoint is invalid");
  }
  const authority = endpointUrl.origin;
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
      lastObservedCatalogVersion:
        connectorCatalogSyncState.lastObservedCatalogVersion,
      lastObservedIntegrityDigest:
        connectorCatalogSyncState.lastObservedIntegrityDigest,
      lastObservedPointerEtag:
        connectorCatalogSyncState.lastObservedPointerEtag,
      lastAttemptAt: connectorCatalogSyncState.lastAttemptAt,
      lastAttemptOutcome: connectorCatalogSyncState.lastAttemptOutcome,
      lastSuccessAt: connectorCatalogSyncState.lastSuccessAt,
      lastFailureCode: connectorCatalogSyncState.lastFailureCode,
      lastRejectedCatalogVersion:
        connectorCatalogSyncState.lastRejectedCatalogVersion,
      lastRejectedIntegrityDigest:
        connectorCatalogSyncState.lastRejectedIntegrityDigest,
      lastRejectedPointerEtag:
        connectorCatalogSyncState.lastRejectedPointerEtag,
      lastRejectedFailureCode:
        connectorCatalogSyncState.lastRejectedFailureCode,
      activeCatalogVersion: connectorCatalogActiveSnapshot.catalogVersion,
      activeIntegrityDigest: connectorCatalogActiveSnapshot.integrityDigest,
      activatedAt: connectorCatalogActiveSnapshot.activatedAt,
    })
    .from(connectorCatalogSyncState)
    .leftJoin(
      connectorCatalogActiveSnapshot,
      and(
        eq(
          connectorCatalogActiveSnapshot.sourceId,
          connectorCatalogSyncState.sourceId,
        ),
        eq(
          connectorCatalogActiveSnapshot.schemaVersion,
          connectorCatalogSyncState.schemaVersion,
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

function statusFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogRawSyncStatus {
  let active: ConnectorCatalogRawSyncStatus["active"] = null;
  if (state?.activeCatalogVersion) {
    if (!state.activatedAt || !state.activeIntegrityDigest) {
      throw new Error("Connector catalog active snapshot is incomplete");
    }
    active = {
      catalogVersion: state.activeCatalogVersion,
      integrityDigest: state.activeIntegrityDigest,
      activatedAt: state.activatedAt.toISOString(),
    };
  }

  let lastAttempt: ConnectorCatalogRawSyncStatus["lastAttempt"] = null;
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
  return (
    pointer.catalogVersion === state?.activeCatalogVersion &&
    pointer.integrityDigest === state.activeIntegrityDigest
  );
}

function observedPointerFromState(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogActivePointer | undefined {
  if (
    !state?.lastObservedCatalogVersion ||
    !state.lastObservedIntegrityDigest
  ) {
    return undefined;
  }
  return {
    catalogVersion: state.lastObservedCatalogVersion,
    integrityDigest: state.lastObservedIntegrityDigest,
  };
}

function cachedRejectionForPointer(
  observation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  },
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogSyncFailureCode | undefined {
  if (
    observation.pointer.catalogVersion !== state?.lastRejectedCatalogVersion ||
    observation.pointer.integrityDigest !== state.lastRejectedIntegrityDigest ||
    ((observation.etag !== null || state.lastRejectedPointerEtag !== null) &&
      observation.etag !== state.lastRejectedPointerEtag)
  ) {
    return undefined;
  }
  return state.lastRejectedFailureCode ?? undefined;
}

function cachedRejectionForObservedEtag(
  state: SyncStateSnapshot | undefined,
): ConnectorCatalogSyncFailureCode | undefined {
  if (
    !state?.lastObservedPointerEtag ||
    state.lastObservedPointerEtag !== state.lastRejectedPointerEtag
  ) {
    return undefined;
  }
  return state.lastRejectedFailureCode ?? undefined;
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

function cacheableRejectedCandidate(
  observation: PointerObservation | undefined,
  failureCode: ConnectorCatalogSyncFailureCode,
): RejectedCandidate | undefined {
  if (
    failureCode === "source-unavailable" ||
    (!observation?.pointer && !observation?.etag)
  ) {
    return undefined;
  }
  return {
    pointer: observation.pointer,
    pointerEtag: observation.etag,
    failureCode,
  };
}

function rejectedCandidateValues(candidate: RejectedCandidate | undefined) {
  if (!candidate) {
    return {};
  }
  return {
    lastRejectedCatalogVersion: candidate.pointer?.catalogVersion ?? null,
    lastRejectedIntegrityDigest: candidate.pointer?.integrityDigest ?? null,
    lastRejectedPointerEtag: candidate.pointerEtag,
    lastRejectedFailureCode: candidate.failureCode,
  };
}

function pointerObservationValues(observation: PointerObservation | undefined) {
  if (!observation) {
    return {};
  }
  return {
    lastObservedCatalogVersion: observation.pointer?.catalogVersion ?? null,
    lastObservedIntegrityDigest: observation.pointer?.integrityDigest ?? null,
    lastObservedPointerEtag: observation.etag,
  };
}

async function recordRejectedAttempt(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly attemptedAt: Date;
  readonly failureCode: ConnectorCatalogSyncFailureCode;
  readonly rejectedCandidate?: RejectedCandidate;
  readonly pointerObservation?: PointerObservation;
}): Promise<boolean> {
  const rejectedValues = rejectedCandidateValues(args.rejectedCandidate);
  const observationValues = pointerObservationValues(args.pointerObservation);
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
        ...observationValues,
        ...rejectedValues,
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
      ...observationValues,
      ...rejectedValues,
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
  readonly pointerObservation?: PointerObservation;
}): Promise<boolean> {
  const observationValues = pointerObservationValues(args.pointerObservation);
  const updated = await args.db
    .update(connectorCatalogSyncState)
    .set({
      revision: sql`${connectorCatalogSyncState.revision} + 1`,
      lastAttemptAt: args.attemptedAt,
      lastAttemptOutcome: "unchanged",
      lastSuccessAt: args.attemptedAt,
      lastFailureCode: null,
      ...observationValues,
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

function activeSnapshotValues(
  candidate: ValidatedConnectorCatalogCandidate,
  activatedAt: Date,
) {
  return {
    catalogVersion: candidate.identity.catalogVersion,
    integrityDigest: candidate.identity.integrityDigest,
    publicCatalogDigest: candidate.identity.publicCatalogDigest,
    privateCatalogDigest: candidate.identity.privateCatalogDigest,
    privateFirewallsDigest: candidate.identity.privateFirewallsDigest,
    runnerFirewallsDigest: candidate.identity.runnerFirewallsDigest,
    publicCatalog: candidate.publicCatalogText,
    privateCatalog: candidate.privateCatalogText,
    privateFirewalls: candidate.privateFirewallsText,
    runnerFirewalls: candidate.runnerFirewallsText,
    activatedAt,
  };
}

async function activateCandidate(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly pointerObservation: PointerObservation;
  readonly attemptedAt: Date;
}): Promise<void> {
  const stateValues = {
    ...pointerObservationValues(args.pointerObservation),
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
  } else {
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

  const snapshotValues = activeSnapshotValues(args.candidate, args.attemptedAt);
  await args.db
    .insert(connectorCatalogActiveSnapshot)
    .values({
      sourceId: args.sourceId,
      schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
      ...snapshotValues,
    })
    .onConflictDoUpdate({
      target: [
        connectorCatalogActiveSnapshot.sourceId,
        connectorCatalogActiveSnapshot.schemaVersion,
      ],
      set: snapshotValues,
    });
}

async function commitCandidate(args: {
  readonly db: Db;
  readonly sourceId: string;
  readonly baseline: SyncStateSnapshot | undefined;
  readonly candidate: ValidatedConnectorCatalogCandidate;
  readonly skillRegistrations: readonly PreparedConnectorSkillRegistration[];
  readonly pointerObservation: PointerObservation;
  readonly attemptedAt: Date;
  readonly signal: AbortSignal;
}): Promise<CandidateCommitResult> {
  const result = await settle(
    args.db.transaction(async (tx) => {
      await registerPreparedConnectorCatalogSkills({
        db: tx,
        registrations: args.skillRegistrations,
        signal: args.signal,
      });
      await activateCandidate({ ...args, db: tx });
      return "accepted" as const;
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof CandidateCommitRetry) {
    return "retry";
  }
  const skillFailure = connectorCatalogSkillFailure(result.error);
  if (skillFailure) {
    return { kind: "rejected", failure: skillFailure };
  }
  throw new ConnectorCatalogPersistenceError();
}

async function responseFromState(args: {
  readonly db: ReadonlyDb;
  readonly sourceId: string;
  readonly outcome: ConnectorCatalogRawSyncResponse["outcome"];
}): Promise<ConnectorCatalogRawSyncResponse> {
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
  readonly rejectedCandidate?: RejectedCandidate;
  readonly pointerObservation?: PointerObservation;
}): Promise<ConnectorCatalogRawSyncResponse | undefined> {
  const committed = await recordRejectedAttempt({
    db: args.db,
    sourceId: args.source.sourceId,
    baseline: args.baseline,
    attemptedAt: nowDate(),
    failureCode: args.failureCode,
    rejectedCandidate: args.rejectedCandidate,
    pointerObservation: args.pointerObservation,
  });
  if (!committed) {
    return undefined;
  }

  log.warn("Connector catalog candidate rejected", {
    sourceId: args.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    failureCode: args.failureCode,
    retainedActiveSnapshot: Boolean(args.baseline?.activeCatalogVersion),
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
  readonly readActivePointer: (
    ifNoneMatch: string | null,
  ) => Promise<ConditionalS3BufferDownload>;
  readonly source: ConnectorCatalogSource;
  readonly signal: AbortSignal;
}

type SyncAttemptResult =
  | { readonly kind: "retry" }
  | {
      readonly kind: "complete";
      readonly response: ConnectorCatalogRawSyncResponse;
    };

type CandidateLoadResult =
  | SyncAttemptResult
  | {
      readonly kind: "loaded";
      readonly candidate: ValidatedConnectorCatalogCandidate;
    };

type PointerLoadResult =
  | SyncAttemptResult
  | { readonly kind: "not-modified" }
  | {
      readonly kind: "loaded";
      readonly pointer: ConnectorCatalogActivePointer;
      readonly etag: string | null;
    };

async function rejectSyncAttempt(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  failureCode: ConnectorCatalogSyncFailureCode,
  pointerObservation?: PointerObservation,
  cacheable = true,
): Promise<SyncAttemptResult> {
  const response = await rejectCandidate({
    db: runtime.db,
    source: runtime.source,
    baseline,
    failureCode,
    rejectedCandidate: cacheable
      ? cacheableRejectedCandidate(pointerObservation, failureCode)
      : undefined,
    pointerObservation,
  });
  runtime.signal.throwIfAborted();
  return response ? { kind: "complete", response } : { kind: "retry" };
}

async function loadPointerForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
): Promise<PointerLoadResult> {
  const downloaded = await settle(
    runtime.readActivePointer(baseline?.lastObservedPointerEtag ?? null),
    runtime.signal,
  );
  runtime.signal.throwIfAborted();
  if (!downloaded.ok) {
    const pointerObservation =
      downloaded.error instanceof S3ObjectSizeLimitError &&
      downloaded.error.etag !== null
        ? { pointer: null, etag: downloaded.error.etag }
        : undefined;
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(downloaded.error),
      pointerObservation,
    );
  }
  if (downloaded.value.kind === "not-modified") {
    return downloaded.value;
  }

  const { buffer, etag } = downloaded.value;
  const parsed = safeSync(() => {
    return parseConnectorCatalogActivePointer(buffer);
  });
  if (!("ok" in parsed)) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(parsed.error),
      { pointer: null, etag },
    );
  }
  return {
    kind: "loaded",
    pointer: parsed.ok,
    etag,
  };
}

async function loadCandidateForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  pointerObservation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  },
): Promise<CandidateLoadResult> {
  const result = await settle(
    loadConnectorCatalogCandidate({
      reader: runtime.reader,
      pointer: pointerObservation.pointer,
    }),
    runtime.signal,
  );
  runtime.signal.throwIfAborted();
  if (!result.ok) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      classifySyncFailure(result.error),
      pointerObservation,
    );
  }
  return { kind: "loaded", candidate: result.value };
}

async function completeUnchangedSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot,
  pointerObservation?: PointerObservation,
): Promise<SyncAttemptResult> {
  const committed = await recordUnchangedAttempt({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    baseline,
    attemptedAt: nowDate(),
    pointerObservation,
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
  skillRegistrations: readonly PreparedConnectorSkillRegistration[],
  pointerObservation: PointerObservation,
): Promise<SyncAttemptResult> {
  const outcome = await commitCandidate({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    baseline,
    candidate,
    skillRegistrations,
    pointerObservation,
    attemptedAt: nowDate(),
    signal: runtime.signal,
  });
  runtime.signal.throwIfAborted();
  if (outcome === "retry") {
    return { kind: "retry" };
  }
  if (typeof outcome !== "string") {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      outcome.failure.code,
      pointerObservation,
      outcome.failure.cacheable,
    );
  }
  log.debug("Connector catalog sync completed", {
    sourceId: runtime.source.sourceId,
    schemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: candidate.identity.catalogVersion,
    integrityDigest: candidate.identity.integrityDigest,
    outcome,
  });
  const response = await responseFromState({
    db: runtime.db,
    sourceId: runtime.source.sourceId,
    outcome,
  });
  runtime.signal.throwIfAborted();
  return { kind: "complete", response };
}

type CandidateSkillPreparationResult =
  | SyncAttemptResult
  | {
      readonly kind: "prepared";
      readonly registrations: readonly PreparedConnectorSkillRegistration[];
    };

async function prepareCandidateSkillsForSync(
  runtime: ConnectorCatalogSyncRuntime,
  baseline: SyncStateSnapshot | undefined,
  candidate: ValidatedConnectorCatalogCandidate,
  pointerObservation: PointerObservation,
): Promise<CandidateSkillPreparationResult> {
  const prepared = await settle(
    prepareConnectorCatalogSkills({
      db: runtime.db,
      reader: runtime.reader,
      privateArtifact: candidate.privateArtifact,
      signal: runtime.signal,
    }),
    runtime.signal,
  );
  if (prepared.ok) {
    return { kind: "prepared", registrations: prepared.value };
  }
  const failure = connectorCatalogSkillFailure(prepared.error);
  if (!failure) {
    throw prepared.error;
  }
  return await rejectSyncAttempt(
    runtime,
    baseline,
    failure.code,
    pointerObservation,
    failure.cacheable,
  );
}

async function syncConnectorCatalogAttempt(
  runtime: ConnectorCatalogSyncRuntime,
): Promise<SyncAttemptResult> {
  const baseline = await readSyncState(runtime.db, runtime.source.sourceId);
  runtime.signal.throwIfAborted();
  const pointerResult = await loadPointerForSync(runtime, baseline);
  if (pointerResult.kind === "retry" || pointerResult.kind === "complete") {
    return pointerResult;
  }

  let pointerObservation: PointerObservation & {
    readonly pointer: ConnectorCatalogActivePointer;
  };
  if (pointerResult.kind === "not-modified") {
    if (!baseline) {
      return await rejectSyncAttempt(runtime, baseline, "source-unavailable");
    }
    const cachedFailure = cachedRejectionForObservedEtag(baseline);
    if (cachedFailure) {
      return await rejectSyncAttempt(runtime, baseline, cachedFailure);
    }
    const observedPointer = observedPointerFromState(baseline);
    if (!observedPointer) {
      return await rejectSyncAttempt(runtime, baseline, "source-unavailable");
    }
    pointerObservation = {
      pointer: observedPointer,
      etag: baseline.lastObservedPointerEtag,
    };
  } else {
    pointerObservation = {
      pointer: pointerResult.pointer,
      etag: pointerResult.etag,
    };
  }

  const { pointer } = pointerObservation;
  if (pointerMatchesActiveState(pointer, baseline)) {
    if (!baseline) {
      throw new Error("Connector catalog active snapshot disappeared");
    }
    return await completeUnchangedSync(runtime, baseline, pointerObservation);
  }

  const cachedFailure = cachedRejectionForPointer(pointerObservation, baseline);
  if (cachedFailure) {
    return await rejectSyncAttempt(
      runtime,
      baseline,
      cachedFailure,
      pointerObservation,
    );
  }

  const candidateResult = await loadCandidateForSync(
    runtime,
    baseline,
    pointerObservation,
  );
  if (candidateResult.kind !== "loaded") {
    return candidateResult;
  }
  const skillPreparation = await prepareCandidateSkillsForSync(
    runtime,
    baseline,
    candidateResult.candidate,
    pointerObservation,
  );
  if (skillPreparation.kind !== "prepared") {
    return skillPreparation;
  }
  return await commitValidatedCandidate(
    runtime,
    baseline,
    candidateResult.candidate,
    skillPreparation.registrations,
    pointerObservation,
  );
}

export const connectorCatalogStatus$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<ConnectorCatalogRawSyncStatus> => {
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
  ): Promise<ConnectorCatalogRawSyncResponse> => {
    const source = connectorCatalogSource();
    const runtime: ConnectorCatalogSyncRuntime = {
      db: set(writeDb$),
      source,
      signal,
      readActivePointer: async (ifNoneMatch) => {
        const result = await get(
          downloadS3BufferWithMaxBytesIfChanged(
            source.bucket,
            CONNECTOR_CATALOG_ACTIVE_KEY,
            CONNECTOR_CATALOG_ACTIVE_MAX_BYTES,
            ifNoneMatch,
            signal,
          ),
        );
        signal.throwIfAborted();
        return result;
      },
      reader: {
        readArtifact: async (key, maxBytes) => {
          const bytes = await get(
            downloadS3BufferWithMaxBytes(source.bucket, key, maxBytes, signal),
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
