import { normalizeGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { adAttributionMetadataSchema } from "@okouai/api-contracts/contracts/acquisition-attribution";
import type {
  ImportedAttributionSnapshot,
  ImportedFirstTouch,
} from "../jsonb-contracts/user-attribution";
import {
  userAcquisitionDeliveryImports,
  userAttributionImports,
  userAttributionImportSnapshots,
  userAttributionBackfillCheckpoints,
} from "../schema/user-attribution";

type ImportDb = PgDatabase<PgQueryResultHKT>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
      })
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Non-JSON attribution evidence");
  return serialized;
}

export function importedAttribution(firstTouch: ImportedFirstTouch) {
  if (!firstTouch.present || !isRecord(firstTouch.value)) return null;
  const { recorded_at: _recordedAt, ...metadata } = firstTouch.value;
  const parsed = adAttributionMetadataSchema.safeParse(metadata);
  return parsed.success ? normalizeGoogleAdsAttribution(parsed.data) : null;
}

function touchState(
  firstTouch: ImportedFirstTouch,
): "absent" | "captured" | "invalid" {
  if (!firstTouch.present) return "absent";
  return importedAttribution(firstTouch) ? "captured" : "invalid";
}

function acceptedDelivery(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.status === "uploaded" || value.status === "submitted")
  );
}

export function clerkAttributionObservation(data: unknown) {
  if (!isRecord(data) || typeof data.id !== "string" || !data.id) {
    throw new Error("Clerk attribution snapshot is missing its user ID");
  }
  const updatedAt = data.updated_at ?? data.updatedAt;
  const metadata = data.private_metadata ?? data.privateMetadata;
  if (
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    !Number.isFinite(new Date(updatedAt).getTime()) ||
    !isRecord(metadata)
  ) {
    throw new Error(
      "Clerk attribution snapshot is missing its version or private metadata",
    );
  }
  const rawDeliveries = metadata.google_data_manager_acquisition_conversions;
  const snapshot: ImportedAttributionSnapshot = {
    firstTouch: {
      present: Object.hasOwn(metadata, "signup_attribution"),
      value: metadata.signup_attribution ?? null,
      privacyReceipt: metadata.marketing_privacy_receipt ?? null,
    },
    deliveries: isRecord(rawDeliveries) ? rawDeliveries : {},
    ...(rawDeliveries !== undefined && !isRecord(rawDeliveries)
      ? { invalidDeliveryMap: { value: rawDeliveries } }
      : {}),
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson({ updatedAt, snapshot }))
    .digest("hex");
  return {
    userId: data.id,
    sourceUpdatedAt: new Date(updatedAt),
    snapshot,
    fingerprint,
    state: snapshot.invalidDeliveryMap
      ? ("conflict" as const)
      : touchState(snapshot.firstTouch),
  };
}

export type ClerkAttributionObservation = ReturnType<
  typeof clerkAttributionObservation
>;

async function mergeDeliveryImports(
  tx: ImportDb,
  observation: ClerkAttributionObservation,
) {
  const { userId, snapshot, sourceUpdatedAt } = observation;
  for (const [transactionId, value] of Object.entries(snapshot.deliveries)) {
    const identity = and(
      eq(userAcquisitionDeliveryImports.userId, userId),
      eq(userAcquisitionDeliveryImports.transactionId, transactionId),
    );
    const [previous] = await tx
      .select()
      .from(userAcquisitionDeliveryImports)
      .where(identity);
    if (!previous) {
      await tx.insert(userAcquisitionDeliveryImports).values({
        userId,
        transactionId,
        latest: { value },
        accepted: acceptedDelivery(value) ? { value } : null,
        sourceUpdatedAt,
      });
      continue;
    }
    const accepted =
      previous.accepted ?? (acceptedDelivery(value) ? { value } : null);
    const equalVersionConflict =
      sourceUpdatedAt.getTime() === previous.sourceUpdatedAt.getTime() &&
      canonicalJson(value) !== canonicalJson(previous.latest.value);
    await tx
      .update(userAcquisitionDeliveryImports)
      .set({
        accepted,
        conflict: previous.conflict || equalVersionConflict,
        ...(sourceUpdatedAt > previous.sourceUpdatedAt
          ? { latest: { value }, sourceUpdatedAt }
          : {}),
      })
      .where(identity);
  }
}

function reconcileImportedTouch(
  current: typeof userAttributionImports.$inferSelect,
  observation: ClerkAttributionObservation,
) {
  const { snapshot, sourceUpdatedAt } = observation;
  const newer = sourceUpdatedAt >= current.sourceUpdatedAt;
  const sameTouch =
    canonicalJson(current.firstTouch) === canonicalJson(snapshot.firstTouch);
  const firstCapture =
    !current.firstTouch.present && snapshot.firstTouch.present;
  let state = snapshot.invalidDeliveryMap
    ? ("conflict" as const)
    : current.state;
  if (state !== "conflict") {
    if (
      (current.firstTouch.present &&
        snapshot.firstTouch.present &&
        !sameTouch) ||
      (newer && current.firstTouch.present && !snapshot.firstTouch.present)
    ) {
      state = "conflict";
    } else if (firstCapture) {
      state = newer ? touchState(snapshot.firstTouch) : "conflict";
    }
  }
  return {
    state,
    firstTouch:
      firstCapture || (!current.firstTouch.present && newer)
        ? snapshot.firstTouch
        : current.firstTouch,
    sourceUpdatedAt: newer ? sourceUpdatedAt : current.sourceUpdatedAt,
  };
}

/** Imported state only. Clerk remains authoritative until #33452's cutover. */
export async function importClerkAttribution(
  db: ImportDb,
  observation: ClerkAttributionObservation,
  source: "webhook" | "backfill",
  signal: AbortSignal,
  runId?: string,
) {
  signal.throwIfAborted();
  return db.transaction(async (tx) => {
    const { userId, snapshot, sourceUpdatedAt, fingerprint } = observation;
    await tx
      .insert(userAttributionImports)
      .values({
        userId,
        firstTouch: snapshot.firstTouch,
        state: snapshot.invalidDeliveryMap
          ? "conflict"
          : touchState(snapshot.firstTouch),
        sourceUpdatedAt,
      })
      .onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(userAttributionImports)
      .where(eq(userAttributionImports.userId, userId))
      .for("update");
    if (!current) throw new Error("Attribution import row was not created");
    if (current.state === "deleted")
      return { state: "deleted" as const, changed: false };

    const inserted = await tx
      .insert(userAttributionImportSnapshots)
      .values({
        userId,
        fingerprint,
        sourceUpdatedAt,
        source,
        snapshot,
      })
      .onConflictDoNothing()
      .returning({ fingerprint: userAttributionImportSnapshots.fingerprint });

    const next = reconcileImportedTouch(current, observation);
    if (inserted.length > 0) {
      await tx
        .update(userAttributionImports)
        .set(next)
        .where(eq(userAttributionImports.userId, userId));
      await mergeDeliveryImports(tx, observation);
    }

    if (runId) {
      await tx
        .insert(userAttributionBackfillCheckpoints)
        .values({ runId, userId, fingerprint })
        .onConflictDoUpdate({
          target: [
            userAttributionBackfillCheckpoints.runId,
            userAttributionBackfillCheckpoints.userId,
          ],
          set: { fingerprint, checkedAt: new Date() },
          setWhere: ne(
            userAttributionBackfillCheckpoints.fingerprint,
            fingerprint,
          ),
        });
    }
    signal.throwIfAborted();
    return { state: next.state, changed: inserted.length > 0 };
  });
}

export async function verifyClerkAttributionImport(
  db: ImportDb,
  observation: ClerkAttributionObservation,
) {
  const { userId, snapshot } = observation;
  const [current] = await db
    .select()
    .from(userAttributionImports)
    .where(eq(userAttributionImports.userId, userId));
  if (!current) return "missing";
  if (current.state === "deleted" || current.state === "conflict")
    return current.state;
  if (current.sourceUpdatedAt > observation.sourceUpdatedAt) return "newer";
  if (
    current.sourceUpdatedAt < observation.sourceUpdatedAt ||
    canonicalJson(current.firstTouch) !== canonicalJson(snapshot.firstTouch)
  )
    return "mismatch";
  const deliveries = await db
    .select()
    .from(userAcquisitionDeliveryImports)
    .where(eq(userAcquisitionDeliveryImports.userId, userId));
  if (
    deliveries.some((row) => {
      return row.conflict;
    })
  )
    return "mismatch";
  const byId = new Map(
    deliveries.map((row) => {
      return [row.transactionId, row];
    }),
  );
  for (const [id, value] of Object.entries(snapshot.deliveries)) {
    const stored = byId.get(id);
    if (
      !stored ||
      stored.conflict ||
      canonicalJson(stored.latest.value) !== canonicalJson(value) ||
      (acceptedDelivery(value) && !stored.accepted)
    )
      return "mismatch";
  }
  return "matched";
}

/** A tombstone prevents delayed events/backfill pages from restoring erased data. */
export async function deleteImportedAttribution(
  db: ImportDb,
  userId: string,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    await tx
      .insert(userAttributionImports)
      .values({
        userId,
        state: "deleted",
        firstTouch: { present: false, value: null, privacyReceipt: null },
        sourceUpdatedAt: new Date(0),
      })
      .onConflictDoUpdate({
        target: userAttributionImports.userId,
        set: {
          state: "deleted",
          firstTouch: { present: false, value: null, privacyReceipt: null },
        },
      });
    await tx
      .delete(userAttributionImportSnapshots)
      .where(eq(userAttributionImportSnapshots.userId, userId));
    await tx
      .delete(userAcquisitionDeliveryImports)
      .where(eq(userAcquisitionDeliveryImports.userId, userId));
    await tx
      .delete(userAttributionBackfillCheckpoints)
      .where(eq(userAttributionBackfillCheckpoints.userId, userId));
    signal.throwIfAborted();
  });
}
