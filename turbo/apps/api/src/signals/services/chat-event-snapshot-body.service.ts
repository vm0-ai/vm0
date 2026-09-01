import { isDeepStrictEqual } from "node:util";

import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";

import { safeJsonParse, safeSync } from "../utils";

const RETIRED_MORNING_BRIEF_CONTEXT = "morning_brief";
const RETIRED_MORNING_BRIEF_PART = "morning_brief";
const RETIRED_MORNING_BRIEF_CUTOVER_ERROR = "legacy_morning_brief_cutover";
const RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE =
  "This legacy Morning Brief was stopped during the Official Workflow cutover.";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

interface MorningBriefSnapshotRepair {
  readonly body: Buffer;
  readonly rows: readonly ChatEventRow[];
  readonly repairedContextRows: number;
  readonly removedDocumentParts: number;
}

export type ChatEventSnapshotProjectionSubstage =
  | "retired_event"
  | "retired_document"
  | "retired_context"
  | "retired_part"
  | "current_contract";

export type ChatEventSnapshotProjectionVariant =
  | "unsupported_event"
  | "invalid_control_revoke"
  | "unresolved_revoke_chain"
  | "unexpected_document"
  | "unscoped_part"
  | "missing_context_id"
  | "duplicate_part"
  | "unexpected_part"
  | "empty_message"
  | "invalid_event_shape";

export class ChatEventSnapshotProjectionError extends Error {
  readonly projectionSubstage: ChatEventSnapshotProjectionSubstage;
  readonly projectionVariant: ChatEventSnapshotProjectionVariant;

  constructor(
    projectionSubstage: ChatEventSnapshotProjectionSubstage,
    projectionVariant: ChatEventSnapshotProjectionVariant,
  ) {
    super("Chat Event Snapshot projection failed");
    this.name = "ChatEventSnapshotProjectionError";
    this.projectionSubstage = projectionSubstage;
    this.projectionVariant = projectionVariant;
  }
}

function failProjection(
  projectionSubstage: ChatEventSnapshotProjectionSubstage,
  projectionVariant: ChatEventSnapshotProjectionVariant,
): never {
  throw new ChatEventSnapshotProjectionError(
    projectionSubstage,
    projectionVariant,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotRawLines(body: Buffer): readonly string[] {
  const text = body.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("Chat Event snapshot must be newline-delimited JSON");
  }
  return text.slice(0, -1).split("\n");
}

function retiredMorningBriefPart(part: unknown): boolean {
  return isRecord(part) && part.type === RETIRED_MORNING_BRIEF_PART;
}

function assertExactRetiredMorningBriefPart(part: unknown): void {
  if (
    !isRecord(part) ||
    Object.keys(part).length !== 2 ||
    part.type !== RETIRED_MORNING_BRIEF_PART ||
    typeof part.briefDate !== "string" ||
    !ISO_DATE_PATTERN.test(part.briefDate)
  ) {
    failProjection("retired_part", "unexpected_part");
  }
}

function isPayloadFreeControlRevoke(row: ChatEventRow): boolean {
  return (
    row.eventType === "control.revoke" &&
    row.runId === null &&
    row.revokesEventId !== null &&
    row.payload === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null
  );
}

function hasExactContextlessMorningBriefPromptPayload(
  row: ChatEventRow,
): boolean {
  const payload = row.payload;
  if (
    payload === null ||
    Object.keys(payload).length !== 1 ||
    payload.userMessage === undefined
  ) {
    return false;
  }
  const userMessage = payload.userMessage;
  return (
    isRecord(userMessage) &&
    Object.keys(userMessage).length === 2 &&
    userMessage.version === 1 &&
    Array.isArray(userMessage.parts) &&
    userMessage.parts.length > 0 &&
    !userMessage.parts.some(retiredMorningBriefPart)
  );
}

function isExactContextlessMorningBriefRoot(row: ChatEventRow): boolean {
  return (
    row.eventType === "input.prompt" &&
    row.runId === null &&
    row.revokesEventId === null &&
    row.contextType === RETIRED_MORNING_BRIEF_CONTEXT &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    hasExactContextlessMorningBriefPromptPayload(row)
  );
}

function hasExactContextlessMorningBriefModelClaimPayload(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  const rootUserMessage = root.payload?.userMessage;
  const claimUserMessage = row.payload?.userMessage;
  if (
    !isRecord(rootUserMessage) ||
    !Array.isArray(rootUserMessage.parts) ||
    !isRecord(claimUserMessage) ||
    !Array.isArray(claimUserMessage.parts) ||
    rootUserMessage.parts.some((part) => {
      return isRecord(part) && part.type === "model";
    }) ||
    claimUserMessage.parts.length !== rootUserMessage.parts.length + 1
  ) {
    return false;
  }
  const modelPart = claimUserMessage.parts.at(-1);
  // The #25467 queue-claim writer copied every original part, then appended
  // exactly one server-owned Run model annotation. The archived Morning Brief
  // fixture predates service-tier annotations, so every wider shape stays
  // fail-closed.
  return (
    isRecord(modelPart) &&
    Object.keys(modelPart).length === 2 &&
    modelPart.type === "model" &&
    typeof modelPart.selectedModel === "string" &&
    modelPart.selectedModel.length > 0 &&
    isDeepStrictEqual(
      claimUserMessage.parts.slice(0, -1),
      rootUserMessage.parts,
    )
  );
}

function isExactContextlessMorningBriefClaim(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    row.id !== root.id &&
    row.chatThreadId === root.chatThreadId &&
    row.eventType === "input.prompt" &&
    row.runId !== null &&
    row.revokesEventId === root.id &&
    row.contextType === RETIRED_MORNING_BRIEF_CONTEXT &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    root.seqId < row.seqId &&
    root.createdAt < row.createdAt &&
    hasExactContextlessMorningBriefPromptPayload(row) &&
    (isDeepStrictEqual(row.payload, root.payload) ||
      hasExactContextlessMorningBriefModelClaimPayload(row, root))
  );
}

function contextlessMorningBriefClaimIds(
  rows: readonly ChatEventRow[],
): ReadonlySet<string> {
  const uniqueRowsById = new Map<string, ChatEventRow | null>();
  const soleRevokerByTargetId = new Map<string, ChatEventRow | null>();
  for (const row of rows) {
    uniqueRowsById.set(row.id, uniqueRowsById.has(row.id) ? null : row);
    if (row.revokesEventId !== null) {
      soleRevokerByTargetId.set(
        row.revokesEventId,
        soleRevokerByTargetId.has(row.revokesEventId) ? null : row,
      );
    }
  }

  const acceptedIds = new Set<string>();
  for (const root of rows) {
    if (
      !isExactContextlessMorningBriefRoot(root) ||
      uniqueRowsById.get(root.id) !== root
    ) {
      continue;
    }
    const claim = soleRevokerByTargetId.get(root.id);
    if (
      claim === undefined ||
      claim === null ||
      uniqueRowsById.get(claim.id) !== claim ||
      !isExactContextlessMorningBriefClaim(claim, root)
    ) {
      continue;
    }
    acceptedIds.add(root.id);
    acceptedIds.add(claim.id);
  }
  return acceptedIds;
}

function hasExactContextlessMorningBriefRetirementPayload(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  const payload = row.payload;
  return (
    payload !== null &&
    Object.keys(payload).length === 2 &&
    payload.error === RETIRED_MORNING_BRIEF_CUTOVER_ERROR &&
    payload.userMessage !== undefined &&
    isDeepStrictEqual(payload.userMessage, root.payload?.userMessage)
  );
}

function isExactContextlessMorningBriefRetirement(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    row.id !== root.id &&
    row.chatThreadId === root.chatThreadId &&
    row.eventType === "input.rejected" &&
    row.runId === null &&
    row.revokesEventId === root.id &&
    row.contextType === RETIRED_MORNING_BRIEF_CONTEXT &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    root.seqId < row.seqId &&
    root.createdAt < row.createdAt &&
    hasExactContextlessMorningBriefRetirementPayload(row, root)
  );
}

function isExactContextlessMorningBriefRetirementCompanion(
  row: ChatEventRow,
  retirement: ChatEventRow,
): boolean {
  const payload = row.payload;
  return (
    row.id !== retirement.id &&
    row.chatThreadId === retirement.chatThreadId &&
    row.eventType === "output.error" &&
    row.runId === null &&
    row.revokesEventId === null &&
    row.contextType === null &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    row.seqId === retirement.seqId + 1 &&
    Date.parse(row.createdAt) === Date.parse(retirement.createdAt) + 1 &&
    payload !== null &&
    Object.keys(payload).length === 2 &&
    payload.content === RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE &&
    payload.error === RETIRED_MORNING_BRIEF_CUTOVER_ERROR
  );
}

function contextlessMorningBriefRetirementIds(
  rows: readonly ChatEventRow[],
): ReadonlySet<string> {
  const uniqueRowsById = new Map<string, ChatEventRow | null>();
  const uniqueRowsBySeqId = new Map<number, ChatEventRow | null>();
  const soleRevokerByTargetId = new Map<string, ChatEventRow | null>();
  for (const row of rows) {
    uniqueRowsById.set(row.id, uniqueRowsById.has(row.id) ? null : row);
    uniqueRowsBySeqId.set(
      row.seqId,
      uniqueRowsBySeqId.has(row.seqId) ? null : row,
    );
    if (row.revokesEventId !== null) {
      soleRevokerByTargetId.set(
        row.revokesEventId,
        soleRevokerByTargetId.has(row.revokesEventId) ? null : row,
      );
    }
  }

  const acceptedIds = new Set<string>();
  for (const root of rows) {
    if (
      !isExactContextlessMorningBriefRoot(root) ||
      uniqueRowsById.get(root.id) !== root
    ) {
      continue;
    }
    const retirement = soleRevokerByTargetId.get(root.id);
    if (
      retirement === undefined ||
      retirement === null ||
      uniqueRowsById.get(retirement.id) !== retirement ||
      !isExactContextlessMorningBriefRetirement(retirement, root)
    ) {
      continue;
    }
    const companion = uniqueRowsBySeqId.get(retirement.seqId + 1);
    if (
      companion === undefined ||
      companion === null ||
      uniqueRowsById.get(companion.id) !== companion ||
      !isExactContextlessMorningBriefRetirementCompanion(companion, retirement)
    ) {
      continue;
    }
    acceptedIds.add(root.id);
    acceptedIds.add(retirement.id);
  }
  return acceptedIds;
}

function isExactRetiredMorningBriefRoot(
  row: ChatEventRow,
  root: ChatEventRow | null | undefined,
): root is ChatEventRow {
  return (
    root !== undefined &&
    root !== null &&
    root.chatThreadId === row.chatThreadId &&
    root.eventType === "input.prompt" &&
    root.runId === null &&
    root.revokesEventId === null &&
    root.contextType === RETIRED_MORNING_BRIEF_CONTEXT &&
    root.contextId === root.id &&
    root.runEventSequenceNumber === null &&
    root.runEventId === null
  );
}

function isExactRetiredMorningBriefRejection(
  row: ChatEventRow,
  target: ChatEventRow | null | undefined,
  root: ChatEventRow,
): boolean {
  return (
    target !== undefined &&
    target !== null &&
    target.chatThreadId === row.chatThreadId &&
    target.eventType === "input.rejected" &&
    target.runId === null &&
    target.revokesEventId === root.id &&
    target.contextType === RETIRED_MORNING_BRIEF_CONTEXT &&
    target.contextId === root.id &&
    target.runEventSequenceNumber === 0 &&
    target.runEventId === null &&
    root.seqId < target.seqId &&
    target.seqId < row.seqId
  );
}

function isExactRetiredMorningBriefRevokeChain(
  row: ChatEventRow,
  priorRowsById: ReadonlyMap<string, ChatEventRow | null>,
): boolean {
  if (
    row.contextId === null ||
    row.revokesEventId === null ||
    row.contextId === row.revokesEventId
  ) {
    return false;
  }
  const target = priorRowsById.get(row.revokesEventId);
  const root = priorRowsById.get(row.contextId);
  return (
    isExactRetiredMorningBriefRoot(row, root) &&
    isExactRetiredMorningBriefRejection(row, target, root)
  );
}

function assertRepairableRetiredMorningBriefEvent(
  row: ChatEventRow,
  priorRowsById: ReadonlyMap<string, ChatEventRow | null>,
): void {
  if (row.eventType === "input.prompt" || row.eventType === "input.rejected") {
    return;
  }
  if (!isPayloadFreeControlRevoke(row)) {
    failProjection(
      "retired_event",
      row.eventType === "control.revoke"
        ? "invalid_control_revoke"
        : "unsupported_event",
    );
  }
  // Queue discard copied the prompt context directly. Recall after the
  // insufficient-credit replacement copied the same root context while its
  // revoke edge targeted the intermediate rejection. Require that complete
  // ordered archive-local chain before accepting the second legacy shape.
  // This is limited to immutable legacy V7 Snapshot state. Remove it after all
  // surviving V7 heads have converged to r1 and the retired writer's rollback
  // window has closed; removal is tracked by #30369 and #28905.
  if (
    row.contextId === row.revokesEventId ||
    isExactRetiredMorningBriefRevokeChain(row, priorRowsById)
  ) {
    return;
  }
  failProjection("retired_event", "unresolved_revoke_chain");
}

function assertCurrentProjection(row: ChatEventRow): void {
  const projected = safeSync(() => {
    chatEventFromRow(row);
  });
  if ("error" in projected) {
    failProjection("current_contract", "invalid_event_shape");
  }
}

function repairMorningBriefRow(
  row: ChatEventRow,
  priorRowsById: ReadonlyMap<string, ChatEventRow | null>,
  contextlessRepairIds: ReadonlySet<string>,
): {
  readonly row: ChatEventRow;
  readonly removedDocumentParts: number;
} {
  const hasRetiredContext = row.contextType === RETIRED_MORNING_BRIEF_CONTEXT;
  const userMessage = row.payload?.userMessage;
  let legacyParts: readonly unknown[] = [];
  let parts: readonly unknown[] | undefined;

  if (hasRetiredContext) {
    assertRepairableRetiredMorningBriefEvent(row, priorRowsById);
  }

  if (userMessage !== undefined) {
    if (!isRecord(userMessage) || !Array.isArray(userMessage.parts)) {
      if (hasRetiredContext) {
        failProjection("retired_document", "unexpected_document");
      }
    } else {
      parts = userMessage.parts;
      legacyParts = parts.filter(retiredMorningBriefPart);
    }
  }

  if (!hasRetiredContext) {
    if (legacyParts.length > 0) {
      failProjection("retired_document", "unscoped_part");
    }
    assertCurrentProjection(row);
    return { row, removedDocumentParts: 0 };
  }
  // Before Morning Brief context rows existed, queue claim wrote an ordered,
  // run-owned replacement prompt. One revision copied the document byte-for-
  // byte; #25467 copied its original parts and appended the authoritative Run
  // model annotation. The Phase A drain fallback also wrote an ordered run-less
  // rejection plus its adjacent error companion. Migration 0836 classified the
  // affected inputs while intentionally preserving their null context IDs.
  // Accept only those complete archive-local relationships; never derive or
  // synthesize an ID. This persisted-state compatibility is limited to
  // immutable legacy V7 Snapshots. Remove it after all surviving V7 heads
  // converge to r1 and the retired writer rollback window closes; removal is
  // tracked by #30369 and #28905.
  if (row.contextId === null && !contextlessRepairIds.has(row.id)) {
    failProjection("retired_context", "missing_context_id");
  }
  if (legacyParts.length > 1) {
    failProjection("retired_part", "duplicate_part");
  }

  const removedDocumentParts = legacyParts.length;
  let payload = row.payload;
  if (removedDocumentParts === 1) {
    const retiredPart = legacyParts[0];
    assertExactRetiredMorningBriefPart(retiredPart);
    if (!isRecord(userMessage) || userMessage.version !== 1 || !parts) {
      failProjection("retired_document", "unexpected_document");
    }
    const currentParts = parts.filter((part) => {
      return part !== retiredPart;
    });
    if (currentParts.length === 0) {
      failProjection("retired_part", "empty_message");
    }
    payload = {
      ...row.payload,
      userMessage: { ...userMessage, parts: currentParts },
    };
  }

  const repaired = chatEventRowSchema.parse({
    ...row,
    contextType: "web",
    contextId: null,
    payload,
  });
  assertCurrentProjection(repaired);
  return { row: repaired, removedDocumentParts };
}

export function decodeChatEventSnapshotBody(
  body: Buffer,
): readonly ChatEventRow[] {
  return snapshotRawLines(body).map((raw) => {
    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      throw new Error("Chat Event snapshot contains invalid JSON");
    }
    return chatEventRowSchema.parse(parsed);
  });
}

/**
 * One-way Phase B archive repair. The retired shape is accepted only inside
 * snapshot publication, then every output row must project through the current
 * strict ChatEvent contract before its new immutable object can be published.
 */
export function repairMorningBriefPhaseBSnapshot(
  body: Buffer,
  decodedRows: readonly ChatEventRow[],
): MorningBriefSnapshotRepair {
  let repairedContextRows = 0;
  let removedDocumentParts = 0;
  let changed = false;
  const rawLines = snapshotRawLines(body);
  if (rawLines.length !== decodedRows.length) {
    throw new Error("Chat Event snapshot decoded row count changed");
  }
  const rows: ChatEventRow[] = [];
  const priorRowsById = new Map<string, ChatEventRow | null>();
  const contextlessRepairIds = new Set([
    ...contextlessMorningBriefClaimIds(decodedRows),
    ...contextlessMorningBriefRetirementIds(decodedRows),
  ]);
  const repairedLines = rawLines.map((raw, index) => {
    const row = decodedRows[index];
    if (row === undefined) {
      throw new Error("Chat Event snapshot decoded row is missing");
    }
    const repaired = repairMorningBriefRow(
      row,
      priorRowsById,
      contextlessRepairIds,
    );
    rows.push(repaired.row);
    priorRowsById.set(row.id, priorRowsById.has(row.id) ? null : row);
    if (repaired.row === row) {
      return Buffer.from(`${raw}\n`);
    }
    changed = true;
    repairedContextRows += 1;
    removedDocumentParts += repaired.removedDocumentParts;
    return Buffer.from(`${JSON.stringify(repaired.row)}\n`);
  });
  return {
    body: changed ? Buffer.concat(repairedLines) : body,
    rows,
    repairedContextRows,
    removedDocumentParts,
  };
}
