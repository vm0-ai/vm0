#!/usr/bin/env tsx

import { Client, Pool, type QueryResult, type QueryResultRow } from "pg";

type ChatThreadEventKind =
  | "created"
  | "renamed"
  | "deleted"
  | "pinned"
  | "unpinned"
  | "sort_touched";

interface CurrentThreadRow {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly sortAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly renamedAt: string | null;
}

interface SnapshotRow {
  readonly userId: string;
  readonly orgId: string;
  readonly latestEventId: string | null;
  readonly chatThreads: unknown;
}

interface EventRow {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly kind: ChatThreadEventKind;
  readonly agentComposeId: string;
  readonly title: string | null;
  readonly createdAt: string;
}

interface ThreadProjection {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly sortAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  readonly renamedAt: string | null;
}

type MutableThreadProjection = {
  -readonly [Key in keyof ThreadProjection]: ThreadProjection[Key];
};

type ComparableField = Exclude<
  keyof ThreadProjection,
  "id" | "userId" | "orgId"
>;

interface Options {
  readonly maxDiffs: number;
  readonly batchSize: number;
  readonly timestampToleranceMs: number;
  readonly ignoreUpdatedAt: boolean;
  readonly ignoreRenamedAt: boolean;
  readonly repeatableRead: boolean;
  readonly recoveryConflictRetries: number;
}

interface QueryRunner {
  query<Row extends QueryResultRow>(
    sqlText: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

interface FieldMismatch {
  readonly kind: "field";
  readonly scope: string;
  readonly threadId: string;
  readonly field: ComparableField;
  readonly current: string | null;
  readonly replayed: string | null;
}

interface PresenceMismatch {
  readonly kind: "missing" | "extra";
  readonly scope: string;
  readonly threadId: string;
}

interface SnapshotMismatch {
  readonly kind: "stale_snapshot_cursor";
  readonly scope: string;
  readonly eventId?: string;
}

interface EventMismatch {
  readonly kind: "orphan_event" | "invalid_event";
  readonly scope: string;
  readonly threadId: string;
  readonly eventId: string;
  readonly eventKind: ChatThreadEventKind;
  readonly reason: string;
}

type Mismatch =
  | FieldMismatch
  | PresenceMismatch
  | SnapshotMismatch
  | EventMismatch;

interface LoadedState {
  readonly currentThreads: readonly CurrentThreadRow[];
  readonly snapshots: readonly SnapshotRow[];
  readonly events: readonly EventRow[];
}

const DEFAULT_MAX_DIFFS = 20;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_RECOVERY_CONFLICT_RETRIES = 3;
const TIMESTAMP_FIELDS = new Set<ComparableField>([
  "sortAt",
  "createdAt",
  "updatedAt",
  "pinnedAt",
  "renamedAt",
]);

function usage(): string {
  return [
    "Usage:",
    "  DATABASE_URL=postgres://... pnpm exec tsx scripts/verify-chat-thread-snapshot-replay.ts",
    "",
    "Options:",
    "  --max-diffs=<n>                 Number of mismatch examples to print. Default: 20",
    "  --batch-size=<n>                Rows to load per query batch. Default: 5000",
    "  --timestamp-tolerance-ms=<n>    Allow small timestamp drift. Default: 0",
    "  --ignore-updated-at             Exclude updatedAt from field comparison",
    "  --ignore-renamed-at             Exclude renamedAt from field comparison",
    "  --repeatable-read               Use one repeatable-read read-only transaction",
    "  --recovery-conflict-retries=<n> Retry hot-standby recovery conflicts. Default: 3",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Options {
  let maxDiffs = DEFAULT_MAX_DIFFS;
  let batchSize = DEFAULT_BATCH_SIZE;
  let timestampToleranceMs = 0;
  let ignoreUpdatedAt = false;
  let ignoreRenamedAt = false;
  let repeatableRead = false;
  let recoveryConflictRetries = DEFAULT_RECOVERY_CONFLICT_RETRIES;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--ignore-updated-at") {
      ignoreUpdatedAt = true;
      continue;
    }

    if (arg === "--ignore-renamed-at") {
      ignoreRenamedAt = true;
      continue;
    }

    if (arg === "--repeatable-read") {
      repeatableRead = true;
      continue;
    }

    if (arg.startsWith("--max-diffs=")) {
      maxDiffs = parsePositiveInteger(arg.slice("--max-diffs=".length), arg);
      continue;
    }

    if (arg.startsWith("--batch-size=")) {
      batchSize = parsePositiveInteger(arg.slice("--batch-size=".length), arg);
      continue;
    }

    if (arg.startsWith("--timestamp-tolerance-ms=")) {
      timestampToleranceMs = parseNonNegativeInteger(
        arg.slice("--timestamp-tolerance-ms=".length),
        arg,
      );
      continue;
    }

    if (arg.startsWith("--recovery-conflict-retries=")) {
      recoveryConflictRetries = parseNonNegativeInteger(
        arg.slice("--recovery-conflict-retries=".length),
        arg,
      );
      continue;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return {
    maxDiffs,
    batchSize,
    timestampToleranceMs,
    ignoreUpdatedAt,
    ignoreRenamedAt,
    repeatableRead,
    recoveryConflictRetries,
  };
}

function parsePositiveInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, arg: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${arg} must be a non-negative integer`);
  }
  return parsed;
}

function scopeKey(userId: string, orgId: string): string {
  return `${userId}\u0000${orgId}`;
}

function formatScope(scope: string): string {
  const [userId, orgId] = scope.split("\u0000");
  return `user_id=${userId ?? ""} org_id=${orgId ?? ""}`;
}

function normalizeTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a timestamp string`);
  }

  const withT = value.replace(" ", "T");
  const withoutZone = withT.replace(/(?:Z|[+-]\d{2}:?\d{2})$/, "");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(
    withoutZone,
  );
  if (!match) {
    throw new Error(`${fieldName} has unsupported timestamp format: ${value}`);
  }

  const whole = match[1];
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return `${whole}.${fraction}`;
}

function normalizeNullableTimestamp(
  value: unknown,
  fieldName: string,
): string | null {
  return value === null ? null : normalizeTimestamp(value, fieldName);
}

function timestampMicros(value: string): bigint {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid normalized timestamp: ${value}`);
  }

  const year = requiredInt(match[1], value);
  const month = requiredInt(match[2], value);
  const day = requiredInt(match[3], value);
  const hour = requiredInt(match[4], value);
  const minute = requiredInt(match[5], value);
  const second = requiredInt(match[6], value);
  const micros = requiredInt(match[7], value);
  const millis = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  return BigInt(millis) * 1000n + BigInt(micros);
}

function requiredInt(value: string | undefined, source: string): number {
  if (value === undefined) {
    throw new Error(`Invalid timestamp component in ${source}`);
  }
  return Number.parseInt(value, 10);
}

function equalValues(
  field: ComparableField,
  current: string | null,
  replayed: string | null,
  options: Options,
): boolean {
  if (current === replayed) {
    return true;
  }
  if (
    current === null ||
    replayed === null ||
    options.timestampToleranceMs === 0 ||
    !TIMESTAMP_FIELDS.has(field)
  ) {
    return false;
  }

  const currentMicros = timestampMicros(current);
  const replayedMicros = timestampMicros(replayed);
  const deltaMicros =
    currentMicros > replayedMicros
      ? currentMicros - replayedMicros
      : replayedMicros - currentMicros;
  return deltaMicros <= BigInt(options.timestampToleranceMs) * 1000n;
}

function readString(
  record: Readonly<Record<string, unknown>>,
  fieldName: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function readNullableString(
  record: Readonly<Record<string, unknown>>,
  fieldName: string,
): string | null {
  const value = record[fieldName];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string or null`);
  }
  return value;
}

function asRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizeSnapshotThread(
  value: unknown,
  userId: string,
  orgId: string,
): ThreadProjection {
  const record = asRecord(value, "snapshot chat thread");
  return {
    id: readString(record, "id"),
    userId,
    orgId,
    agentId: readString(record, "agentId"),
    title: readNullableString(record, "title"),
    sortAt: normalizeTimestamp(record.sortAt, "sortAt"),
    createdAt: normalizeTimestamp(record.createdAt, "createdAt"),
    updatedAt: normalizeTimestamp(record.updatedAt, "updatedAt"),
    pinnedAt: normalizeNullableTimestamp(record.pinnedAt, "pinnedAt"),
    renamedAt: normalizeNullableTimestamp(record.renamedAt, "renamedAt"),
  };
}

function normalizeCurrentThread(row: CurrentThreadRow): ThreadProjection {
  return {
    ...row,
    sortAt: normalizeTimestamp(row.sortAt, "sortAt"),
    createdAt: normalizeTimestamp(row.createdAt, "createdAt"),
    updatedAt: normalizeTimestamp(row.updatedAt, "updatedAt"),
    pinnedAt: normalizeNullableTimestamp(row.pinnedAt, "pinnedAt"),
    renamedAt: normalizeNullableTimestamp(row.renamedAt, "renamedAt"),
  };
}

function normalizeEvent(row: EventRow): EventRow {
  return {
    ...row,
    createdAt: normalizeTimestamp(row.createdAt, "event.createdAt"),
  };
}

function mapSet<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
    return;
  }
  map.set(key, [value]);
}

function threadMapFromThreads(
  threads: Iterable<ThreadProjection>,
): Map<string, MutableThreadProjection> {
  const map = new Map<string, MutableThreadProjection>();
  for (const thread of threads) {
    map.set(thread.id, { ...thread });
  }
  return map;
}

function groupedCurrentThreads(
  rows: readonly CurrentThreadRow[],
): Map<string, Map<string, MutableThreadProjection>> {
  const scopes = new Map<string, Map<string, MutableThreadProjection>>();
  for (const row of rows) {
    const thread = normalizeCurrentThread(row);
    const scope = scopeKey(thread.userId, thread.orgId);
    let threads = scopes.get(scope);
    if (!threads) {
      threads = new Map();
      scopes.set(scope, threads);
    }
    threads.set(thread.id, { ...thread });
  }
  return scopes;
}

function snapshotThreads(row: SnapshotRow): readonly ThreadProjection[] {
  if (!Array.isArray(row.chatThreads)) {
    throw new Error(
      `chat_threads snapshot must be an array for ${formatScope(
        scopeKey(row.userId, row.orgId),
      )}`,
    );
  }
  return row.chatThreads.map((thread) => {
    return normalizeSnapshotThread(thread, row.userId, row.orgId);
  });
}

function buildComparableFields(options: Options): readonly ComparableField[] {
  const fields: ComparableField[] = [
    "agentId",
    "title",
    "sortAt",
    "createdAt",
    "updatedAt",
    "pinnedAt",
    "renamedAt",
  ];
  return fields.filter((field) => {
    if (field === "updatedAt" && options.ignoreUpdatedAt) {
      return false;
    }
    if (field === "renamedAt" && options.ignoreRenamedAt) {
      return false;
    }
    return true;
  });
}

function applyEvent(
  threads: Map<string, MutableThreadProjection>,
  event: EventRow,
  mismatches: Mismatch[],
): void {
  const scope = scopeKey(event.userId, event.orgId);
  const existing = threads.get(event.chatThreadId);

  if (event.kind === "created") {
    threads.set(event.chatThreadId, {
      id: event.chatThreadId,
      userId: event.userId,
      orgId: event.orgId,
      agentId: event.agentComposeId,
      title: event.title,
      sortAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      pinnedAt: null,
      renamedAt: null,
    });
    return;
  }

  if (!existing) {
    mismatches.push({
      kind: "orphan_event",
      scope,
      threadId: event.chatThreadId,
      eventId: event.id,
      eventKind: event.kind,
      reason:
        "event refers to a thread that is not present in the replay state",
    });
    return;
  }

  switch (event.kind) {
    case "renamed":
      existing.title = event.title;
      existing.renamedAt = event.createdAt;
      return;
    case "deleted":
      threads.delete(event.chatThreadId);
      return;
    case "pinned":
      existing.pinnedAt = event.createdAt;
      return;
    case "unpinned":
      existing.pinnedAt = null;
      return;
    case "sort_touched":
      existing.sortAt = event.createdAt;
      return;
    default:
      mismatches.push({
        kind: "invalid_event",
        scope,
        threadId: event.chatThreadId,
        eventId: event.id,
        eventKind: event.kind,
        reason: "unknown chat thread event kind",
      });
  }
}

function replayScopes(
  snapshots: readonly SnapshotRow[],
  events: readonly EventRow[],
): {
  readonly replayed: Map<string, Map<string, MutableThreadProjection>>;
  readonly mismatches: readonly Mismatch[];
  readonly eventScopes: ReadonlySet<string>;
  readonly eventScopesWithoutSnapshotRows: number;
} {
  const mismatches: Mismatch[] = [];
  const replayed = new Map<string, Map<string, MutableThreadProjection>>();
  const eventsByScope = new Map<string, EventRow[]>();
  const snapshotScopes = new Set<string>();
  const eventScopes = new Set<string>();
  const eventScopesWithoutSnapshotRows = new Set<string>();

  for (const event of events.map(normalizeEvent)) {
    const scope = scopeKey(event.userId, event.orgId);
    mapSet(eventsByScope, scope, event);
    eventScopes.add(scope);
  }

  for (const snapshot of snapshots) {
    const scope = scopeKey(snapshot.userId, snapshot.orgId);
    snapshotScopes.add(scope);
    const scopedEvents = eventsByScope.get(scope) ?? [];
    const cursorIndex =
      snapshot.latestEventId === null
        ? -1
        : scopedEvents.findIndex((event) => {
            return event.id === snapshot.latestEventId;
          });

    if (snapshot.latestEventId !== null && cursorIndex === -1) {
      mismatches.push({
        kind: "stale_snapshot_cursor",
        scope,
        eventId: snapshot.latestEventId,
      });
    }

    const threads = threadMapFromThreads(snapshotThreads(snapshot));
    const replayStartIndex =
      snapshot.latestEventId === null
        ? 0
        : cursorIndex === -1
          ? scopedEvents.length
          : cursorIndex + 1;
    for (const event of scopedEvents.slice(replayStartIndex)) {
      applyEvent(threads, event, mismatches);
    }
    replayed.set(scope, threads);
  }

  for (const [scope, scopedEvents] of eventsByScope) {
    if (snapshotScopes.has(scope)) {
      continue;
    }
    eventScopesWithoutSnapshotRows.add(scope);

    const threads = new Map<string, MutableThreadProjection>();
    for (const event of scopedEvents) {
      applyEvent(threads, event, mismatches);
    }
    replayed.set(scope, threads);
  }

  return {
    replayed,
    mismatches,
    eventScopes,
    eventScopesWithoutSnapshotRows: eventScopesWithoutSnapshotRows.size,
  };
}

function compareScopes(
  current: Map<string, Map<string, MutableThreadProjection>>,
  replayed: Map<string, Map<string, MutableThreadProjection>>,
  initialMismatches: readonly Mismatch[],
  options: Options,
): readonly Mismatch[] {
  const mismatches: Mismatch[] = [...initialMismatches];
  const comparableFields = buildComparableFields(options);
  const scopes = new Set([...current.keys(), ...replayed.keys()]);

  for (const scope of [...scopes].sort()) {
    const currentThreads = current.get(scope) ?? new Map();
    const replayedThreads = replayed.get(scope) ?? new Map();
    const threadIds = new Set([
      ...currentThreads.keys(),
      ...replayedThreads.keys(),
    ]);

    for (const threadId of [...threadIds].sort()) {
      const currentThread = currentThreads.get(threadId);
      const replayedThread = replayedThreads.get(threadId);

      if (!currentThread) {
        mismatches.push({ kind: "extra", scope, threadId });
        continue;
      }

      if (!replayedThread) {
        mismatches.push({ kind: "missing", scope, threadId });
        continue;
      }

      for (const field of comparableFields) {
        const currentValue = currentThread[field];
        const replayedValue = replayedThread[field];
        if (!equalValues(field, currentValue, replayedValue, options)) {
          mismatches.push({
            kind: "field",
            scope,
            threadId,
            field,
            current: currentValue,
            replayed: replayedValue,
          });
        }
      }
    }
  }

  return mismatches;
}

async function loadCurrentThreads(
  runner: QueryRunner,
  options: Options,
): Promise<CurrentThreadRow[]> {
  const rows: CurrentThreadRow[] = [];
  let cursor: CurrentThreadRow | undefined;

  for (;;) {
    const batch = await queryWithRecoveryRetry<CurrentThreadRow>(
      runner,
      `
    SELECT
      ct.id,
      ct.user_id AS "userId",
      ac.org_id AS "orgId",
      ct.agent_compose_id AS "agentId",
      ct.title,
      to_jsonb(ct.last_message_at) #>> '{}' AS "sortAt",
      to_jsonb(ct.created_at) #>> '{}' AS "createdAt",
      to_jsonb(ct.updated_at) #>> '{}' AS "updatedAt",
      to_jsonb(ct.pinned_at) #>> '{}' AS "pinnedAt",
      to_jsonb(ct.renamed_at) #>> '{}' AS "renamedAt"
    FROM chat_threads ct
    INNER JOIN agent_composes ac
      ON ac.id = ct.agent_compose_id
    WHERE (
      $1::text IS NULL
      OR (ct.user_id, ac.org_id, ct.id) > ($1::text, $2::text, $3::uuid)
    )
    ORDER BY ct.user_id, ac.org_id, ct.id
    LIMIT $4
  `,
      [
        cursor?.userId ?? null,
        cursor?.orgId ?? null,
        cursor?.id ?? null,
        options.batchSize,
      ],
      "current chat thread query",
      options.recoveryConflictRetries,
    );

    rows.push(...batch.rows);
    if (batch.rows.length < options.batchSize) {
      return rows;
    }
    cursor = batch.rows.at(-1);
  }
}

async function loadSnapshots(
  runner: QueryRunner,
  options: Options,
): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  let cursor: SnapshotRow | undefined;

  for (;;) {
    const batch = await queryWithRecoveryRetry<SnapshotRow>(
      runner,
      `
    SELECT
      user_id AS "userId",
      org_id AS "orgId",
      latest_event_id AS "latestEventId",
      chat_threads AS "chatThreads"
    FROM chat_thread_snapshots
    WHERE (
      $1::text IS NULL
      OR (user_id, org_id) > ($1::text, $2::text)
    )
    ORDER BY user_id, org_id
    LIMIT $3
  `,
      [cursor?.userId ?? null, cursor?.orgId ?? null, options.batchSize],
      "chat thread snapshot query",
      options.recoveryConflictRetries,
    );

    rows.push(...batch.rows);
    if (batch.rows.length < options.batchSize) {
      return rows;
    }
    cursor = batch.rows.at(-1);
  }
}

async function loadEvents(
  runner: QueryRunner,
  options: Options,
): Promise<EventRow[]> {
  const rows: EventRow[] = [];
  let cursor: EventRow | undefined;

  for (;;) {
    const batch = await queryWithRecoveryRetry<EventRow>(
      runner,
      `
    SELECT
      id,
      user_id AS "userId",
      org_id AS "orgId",
      chat_thread_id AS "chatThreadId",
      kind,
      agent_compose_id AS "agentComposeId",
      title,
      to_jsonb(created_at) #>> '{}' AS "createdAt"
    FROM chat_thread_events
    WHERE (
      $1::text IS NULL
      OR (user_id, org_id, created_at, id) >
        ($1::text, $2::text, $3::timestamp, $4::uuid)
    )
    ORDER BY user_id, org_id, created_at, id
    LIMIT $5
  `,
      [
        cursor?.userId ?? null,
        cursor?.orgId ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        options.batchSize,
      ],
      "chat thread event query",
      options.recoveryConflictRetries,
    );

    rows.push(...batch.rows);
    if (batch.rows.length < options.batchSize) {
      return rows;
    }
    cursor = batch.rows.at(-1);
  }
}

async function loadState(
  runner: QueryRunner,
  options: Options,
): Promise<LoadedState> {
  console.log(
    `Loading current chat threads in batches of ${options.batchSize}...`,
  );
  const currentThreads = await loadCurrentThreads(runner, options);
  console.log(`Loaded current chat threads: ${currentThreads.length}`);

  console.log(
    `Loading chat thread snapshots in batches of ${options.batchSize}...`,
  );
  const snapshots = await loadSnapshots(runner, options);
  console.log(`Loaded chat thread snapshots: ${snapshots.length}`);

  console.log(
    `Loading chat thread events in batches of ${options.batchSize}...`,
  );
  const events = await loadEvents(runner, options);
  console.log(`Loaded chat thread events: ${events.length}`);

  return {
    currentThreads,
    snapshots,
    events,
  };
}

function printMismatch(mismatch: Mismatch): void {
  switch (mismatch.kind) {
    case "field":
      console.log(
        [
          `field mismatch: ${formatScope(mismatch.scope)}`,
          `thread_id=${mismatch.threadId}`,
          `field=${mismatch.field}`,
          `current=${JSON.stringify(mismatch.current)}`,
          `replayed=${JSON.stringify(mismatch.replayed)}`,
        ].join(" "),
      );
      return;
    case "missing":
      console.log(
        `missing in replay: ${formatScope(mismatch.scope)} thread_id=${
          mismatch.threadId
        }`,
      );
      return;
    case "extra":
      console.log(
        `extra in replay: ${formatScope(mismatch.scope)} thread_id=${
          mismatch.threadId
        }`,
      );
      return;
    case "stale_snapshot_cursor":
      console.log(
        `snapshot cursor event not found: ${formatScope(
          mismatch.scope,
        )} latest_event_id=${mismatch.eventId ?? ""}`,
      );
      return;
    case "orphan_event":
    case "invalid_event":
      console.log(
        [
          `${mismatch.kind}: ${formatScope(mismatch.scope)}`,
          `thread_id=${mismatch.threadId}`,
          `event_id=${mismatch.eventId}`,
          `event_kind=${mismatch.eventKind}`,
          `reason=${JSON.stringify(mismatch.reason)}`,
        ].join(" "),
      );
      return;
  }
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printCountMap(title: string, map: ReadonlyMap<string, number>): void {
  if (map.size === 0) {
    return;
  }

  console.log(title);
  for (const [key, count] of [...map.entries()].sort((left, right) => {
    return right[1] - left[1] || left[0].localeCompare(right[0]);
  })) {
    console.log(`  ${key}: ${count}`);
  }
}

function printMismatchSummary(mismatches: readonly Mismatch[]): void {
  const byKind = new Map<string, number>();
  const byField = new Map<string, number>();

  for (const mismatch of mismatches) {
    incrementCount(byKind, mismatch.kind);
    if (mismatch.kind === "field") {
      incrementCount(byField, mismatch.field);
    }
  }

  printCountMap("Mismatch summary by kind:", byKind);
  printCountMap("Field mismatch summary:", byField);
}

function isRecoveryConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "40001"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isConnectionTermination(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "08003" ||
    code === "08006" ||
    code === "57P01" ||
    code === "57P02" ||
    errorMessage(error).includes("Connection terminated unexpectedly")
  );
}

function isRetriableQueryError(error: unknown): boolean {
  return isRecoveryConflict(error) || isConnectionTermination(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function queryWithRecoveryRetry<Row extends QueryResultRow>(
  runner: QueryRunner,
  sqlText: string,
  values: unknown[],
  label: string,
  retries: number,
): Promise<QueryResult<Row>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runner.query<Row>(sqlText, values);
    } catch (error) {
      if (!isRetriableQueryError(error) || attempt >= retries) {
        throw error;
      }

      const delayMs = 1000 * (attempt + 1);
      console.warn(
        `${label} failed with a retriable database error (${errorMessage(
          error,
        )}); retrying in ${delayMs}ms (${attempt + 1}/${retries})`,
      );
      await sleep(delayMs);
    }
  }
}

async function loadStateWithRepeatableRead(
  client: Client,
  options: Options,
): Promise<LoadedState> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    return await loadState(client, { ...options, recoveryConflictRetries: 0 });
  } finally {
    await client.query("ROLLBACK");
  }
}

function logDatabaseClientError(error: Error): void {
  console.warn(`database connection emitted an error: ${error.message}`);
}

async function loadStateWithPool(
  databaseUrl: string,
  options: Options,
): Promise<LoadedState> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  pool.on("error", logDatabaseClientError);
  try {
    return await loadState(pool, options);
  } finally {
    await pool.end();
  }
}

async function loadStateWithClientTransaction(
  databaseUrl: string,
  options: Options,
): Promise<LoadedState> {
  const client = new Client({ connectionString: databaseUrl });
  client.on("error", logDatabaseClientError);

  await client.connect();
  try {
    return await loadStateWithRepeatableRead(client, options);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(`DATABASE_URL is required\n\n${usage()}`);
  }

  const loaded = options.repeatableRead
    ? await loadStateWithClientTransaction(databaseUrl, options)
    : await loadStateWithPool(databaseUrl, options);
  const current = groupedCurrentThreads(loaded.currentThreads);
  const replayResult = replayScopes(loaded.snapshots, loaded.events);
  const mismatches = compareScopes(
    current,
    replayResult.replayed,
    replayResult.mismatches,
    options,
  );

  console.log("Loaded state:");
  console.log(`  current chat_threads: ${loaded.currentThreads.length}`);
  console.log(`  current scopes: ${current.size}`);
  console.log(`  snapshot scopes: ${loaded.snapshots.length}`);
  console.log(`  event rows: ${loaded.events.length}`);
  console.log(`  event scopes: ${replayResult.eventScopes.size}`);
  console.log(
    `  event scopes without snapshot rows: ${replayResult.eventScopesWithoutSnapshotRows}`,
  );
  console.log(`  replayed scopes: ${replayResult.replayed.size}`);

  if (mismatches.length === 0) {
    console.log(
      "OK: current chat_threads projection matches snapshot + event replay.",
    );
    return;
  }

  console.log("");
  console.log(`Found ${mismatches.length} mismatch(es).`);
  printMismatchSummary(mismatches);
  console.log(
    `Showing first ${Math.min(options.maxDiffs, mismatches.length)}:`,
  );
  for (const mismatch of mismatches.slice(0, options.maxDiffs)) {
    printMismatch(mismatch);
  }
  process.exitCode = 1;
}

await main();
