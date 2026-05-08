// Repository port for `voice_chat_realtime_sessions` row state. The schema +
// migration that creates the underlying table is owned by sub-issue #12138.
// While #12138 is in flight, this PR ships:
//
//   - The port (RelaySessionRepository) — what the relay loop calls.
//   - An in-memory implementation — used in tests and as the default
//     production wiring in this PR. Sufficient to exercise the full event
//     pipeline; row state is observable via getStatus()/list() in tests.
//
// After #12138 lands, a follow-up PR (or sub-issue #12142's wiring step)
// adds a Drizzle-backed implementation that targets the real table. The
// port stays unchanged.

import { randomUUID } from "node:crypto";

import { nowDate } from "../../../lib/time";

type RelaySessionStatus = "starting" | "active" | "ended" | "error";

export interface RelaySessionRow {
  readonly id: string;
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: "openai";
  readonly model: string;
  readonly transcriptionModel: string;
  readonly openaiSessionId: string | null;
  readonly status: RelaySessionStatus;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly error: string | null;
}

export interface InsertStartingInput {
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly model: string;
  readonly transcriptionModel: string;
}

export interface RelaySessionRepository {
  insertStarting(input: InsertStartingInput): Promise<RelaySessionRow>;
  markActive(relaySessionId: string, openaiSessionId: string): Promise<void>;
  markEnded(relaySessionId: string): Promise<void>;
  markError(relaySessionId: string, error: string): Promise<void>;
}

interface InternalRow {
  id: string;
  voiceChatSessionId: string;
  orgId: string;
  userId: string;
  provider: "openai";
  model: string;
  transcriptionModel: string;
  openaiSessionId: string | null;
  status: RelaySessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  error: string | null;
}

function toRow(internal: InternalRow): RelaySessionRow {
  return { ...internal };
}

// In-memory repository used by tests and (until #12138 ships) by the
// production relay route. Single-process; reconnects across instances are
// not coordinated. Once the real table exists, swap to the drizzle impl.
interface InMemoryRelaySessionRepository extends RelaySessionRepository {
  readonly list: () => readonly RelaySessionRow[];
  readonly get: (relaySessionId: string) => RelaySessionRow | undefined;
}

export function createInMemoryRelaySessionRepository(): InMemoryRelaySessionRepository {
  const rows = new Map<string, InternalRow>();
  return {
    insertStarting: (input) => {
      const id = randomUUID();
      const internal: InternalRow = {
        id,
        voiceChatSessionId: input.voiceChatSessionId,
        orgId: input.orgId,
        userId: input.userId,
        provider: "openai",
        model: input.model,
        transcriptionModel: input.transcriptionModel,
        openaiSessionId: null,
        status: "starting",
        startedAt: nowDate(),
        endedAt: null,
        error: null,
      };
      rows.set(id, internal);
      return Promise.resolve(toRow(internal));
    },
    markActive: (relaySessionId, openaiSessionId) => {
      const row = rows.get(relaySessionId);
      if (row !== undefined && row.status === "starting") {
        row.status = "active";
        row.openaiSessionId = openaiSessionId;
      }
      return Promise.resolve();
    },
    markEnded: (relaySessionId) => {
      const row = rows.get(relaySessionId);
      // Don't downgrade an already-error row to ended; the first terminal
      // transition wins (matches the lifecycle state machine in the plan).
      if (
        row !== undefined &&
        row.status !== "ended" &&
        row.status !== "error"
      ) {
        row.status = "ended";
        row.endedAt = nowDate();
      }
      return Promise.resolve();
    },
    markError: (relaySessionId, error) => {
      const row = rows.get(relaySessionId);
      if (
        row !== undefined &&
        row.status !== "ended" &&
        row.status !== "error"
      ) {
        row.status = "error";
        row.endedAt = nowDate();
        row.error = error;
      }
      return Promise.resolve();
    },
    list() {
      return Array.from(rows.values()).map(toRow);
    },
    get(relaySessionId) {
      const row = rows.get(relaySessionId);
      return row === undefined ? undefined : toRow(row);
    },
  };
}
