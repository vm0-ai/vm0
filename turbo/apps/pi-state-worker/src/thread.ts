import {
  isNonEmptyString,
  isRecord,
  isStringArray,
  isUnknownArray,
} from "./guards";

export const CAPABILITY_HEADER = "x-pi-state-capability";

const READ_SCOPE = "messages:read";
const APPEND_SCOPE = "messages:append";
const IMPORT_SCOPE = "messages:import";
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_APPEND_BATCH_SIZE = 100;

export type SqlValue = string | number | null;

export interface SqlCursor<T> {
  toArray(): T[];
}

interface SqlDatabase {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: SqlValue[]
  ): SqlCursor<T>;
}

export interface ThreadStoreContext {
  readonly sql: SqlDatabase;
  transactionSync<T>(closure: () => T): T;
}

interface ThreadHead {
  readonly version: number;
  readonly lastOrdinal: number;
}

interface StoredMessage {
  readonly ordinal: number;
  readonly messageId: string;
  readonly runId: string;
  readonly role: string;
  readonly payload: unknown;
  readonly createdAt: number;
}

interface IncomingMessage {
  readonly messageId: string;
  readonly runId: string;
  readonly role: string;
  readonly payload: unknown;
}

interface AppendRequest {
  readonly expectedVersion: number;
  readonly expectedLastOrdinal: number;
  readonly messages: readonly IncomingMessage[];
}

interface PreparedMessage {
  readonly messageId: string;
  readonly runId: string;
  readonly role: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly sizeBytes: number;
}

interface ThreadRequestAuth {
  readonly runId: string;
  readonly scopes: readonly string[];
}

type AppendOutcome =
  | { readonly kind: "appended"; readonly head: ThreadHead }
  | { readonly kind: "replayed"; readonly head: ThreadHead }
  | { readonly kind: "head-conflict"; readonly head: ThreadHead }
  | { readonly kind: "message-conflict"; readonly messageId: string };

type HeadRow = {
  version: number;
  ordinal: number;
};

type MessageRow = {
  ordinal: number;
  message_id: string;
  run_id: string;
  role: string;
  payload: string;
  created_at: number;
};

type ExistingMessageRow = {
  version: number;
  ordinal: number;
  run_id: string;
  payload_hash: string;
};

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS messages (
    version INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_storage TEXT NOT NULL,
    r2_key TEXT,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (version, ordinal)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS messages_by_message_id ON messages (message_id)",
];

export class ThreadStore {
  private readonly context: ThreadStoreContext;

  constructor(context: ThreadStoreContext) {
    this.context = context;
    for (const statement of SCHEMA_STATEMENTS) {
      context.sql.exec(statement);
    }
  }

  head(): ThreadHead {
    const row = this.context.sql
      .exec<HeadRow>(
        "SELECT version, ordinal FROM messages ORDER BY version DESC, ordinal DESC LIMIT 1",
      )
      .toArray()[0];
    if (!row) {
      return { version: 1, lastOrdinal: 0 };
    }
    return { version: row.version, lastOrdinal: row.ordinal };
  }

  readLatest(): { head: ThreadHead; messages: StoredMessage[] } {
    const head = this.head();
    const messages = this.context.sql
      .exec<MessageRow>(
        "SELECT ordinal, message_id, run_id, role, payload, created_at FROM messages WHERE version = ? ORDER BY ordinal",
        head.version,
      )
      .toArray()
      .map((row): StoredMessage => {
        return {
          ordinal: row.ordinal,
          messageId: row.message_id,
          runId: row.run_id,
          role: row.role,
          payload: JSON.parse(row.payload) as unknown,
          createdAt: row.created_at,
        };
      });
    return { head, messages };
  }

  append(
    expected: ThreadHead,
    messages: readonly PreparedMessage[],
    appendedAt: number,
  ): AppendOutcome {
    return this.context.transactionSync(() => {
      const head = this.head();
      const entries = messages.map((message) => {
        return { message, existing: this.findByMessageId(message.messageId) };
      });
      const anyExisting = entries.some((entry) => {
        return entry.existing !== null;
      });
      if (anyExisting) {
        const mismatch = entries.find((entry, index) => {
          const { message, existing } = entry;
          return (
            !existing ||
            existing.payload_hash !== message.payloadHash ||
            existing.run_id !== message.runId ||
            existing.version !== expected.version ||
            existing.ordinal !== expected.lastOrdinal + index + 1
          );
        });
        if (mismatch) {
          return {
            kind: "message-conflict" as const,
            messageId: mismatch.message.messageId,
          };
        }
        return { kind: "replayed" as const, head };
      }
      if (
        head.version !== expected.version ||
        head.lastOrdinal !== expected.lastOrdinal
      ) {
        return { kind: "head-conflict" as const, head };
      }
      messages.forEach((message, index) => {
        this.context.sql.exec(
          "INSERT INTO messages (version, ordinal, message_id, run_id, role, payload, payload_hash, payload_storage, r2_key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          expected.version,
          expected.lastOrdinal + index + 1,
          message.messageId,
          message.runId,
          message.role,
          message.payloadJson,
          message.payloadHash,
          "inline",
          null,
          message.sizeBytes,
          appendedAt,
        );
      });
      return {
        kind: "appended" as const,
        head: {
          version: expected.version,
          lastOrdinal: expected.lastOrdinal + messages.length,
        },
      };
    });
  }

  private findByMessageId(messageId: string): ExistingMessageRow | null {
    const row = this.context.sql
      .exec<ExistingMessageRow>(
        "SELECT version, ordinal, run_id, payload_hash FROM messages WHERE message_id = ?",
        messageId,
      )
      .toArray()[0];
    return row ?? null;
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseAuthHeader(request: Request): ThreadRequestAuth | null {
  const header = request.headers.get(CAPABILITY_HEADER);
  if (!header) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(header) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (!isNonEmptyString(value.runId) || !isStringArray(value.scopes)) {
    return null;
  }
  return { runId: value.runId, scopes: value.scopes };
}

function parseIncomingMessage(value: unknown): IncomingMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.role)
  ) {
    return null;
  }
  if (!("payload" in value)) {
    return null;
  }
  return {
    messageId: value.messageId,
    runId: value.runId,
    role: value.role,
    payload: value.payload,
  };
}

function parseAppendRequest(value: unknown): AppendRequest | null {
  if (!isRecord(value)) {
    return null;
  }
  const { expectedVersion, expectedLastOrdinal } = value;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return null;
  }
  if (
    typeof expectedLastOrdinal !== "number" ||
    !Number.isInteger(expectedLastOrdinal) ||
    expectedLastOrdinal < 0
  ) {
    return null;
  }
  if (
    !isUnknownArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_APPEND_BATCH_SIZE
  ) {
    return null;
  }
  const messages: IncomingMessage[] = [];
  for (const entry of value.messages) {
    const message = parseIncomingMessage(entry);
    if (!message) {
      return null;
    }
    messages.push(message);
  }
  return { expectedVersion, expectedLastOrdinal, messages };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) => {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

function handleRead(store: ThreadStore, auth: ThreadRequestAuth): Response {
  if (!auth.scopes.includes(READ_SCOPE)) {
    return jsonResponse(403, { error: "forbidden" });
  }
  const { head, messages } = store.readLatest();
  return jsonResponse(200, {
    version: head.version,
    lastOrdinal: head.lastOrdinal,
    messages,
  });
}

async function handleAppend(
  store: ThreadStore,
  auth: ThreadRequestAuth,
  request: Request,
): Promise<Response> {
  if (!auth.scopes.includes(APPEND_SCOPE)) {
    return jsonResponse(403, { error: "forbidden" });
  }
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const append = parseAppendRequest(body);
  if (!append) {
    return jsonResponse(400, { error: "invalid_request" });
  }
  if (!auth.scopes.includes(IMPORT_SCOPE)) {
    const mismatch = append.messages.find((message) => {
      return message.runId !== auth.runId;
    });
    if (mismatch) {
      return jsonResponse(403, {
        error: "run_mismatch",
        messageId: mismatch.messageId,
      });
    }
  }
  const serialized: {
    message: IncomingMessage;
    payloadJson: string;
    sizeBytes: number;
  }[] = [];
  for (const message of append.messages) {
    const payloadJson = JSON.stringify(message.payload);
    const sizeBytes = new TextEncoder().encode(payloadJson).byteLength;
    if (sizeBytes > MAX_PAYLOAD_BYTES) {
      return jsonResponse(413, {
        error: "payload_too_large",
        messageId: message.messageId,
      });
    }
    serialized.push({ message, payloadJson, sizeBytes });
  }
  const prepared = await Promise.all(
    serialized.map(async (entry): Promise<PreparedMessage> => {
      return {
        messageId: entry.message.messageId,
        runId: entry.message.runId,
        role: entry.message.role,
        payloadJson: entry.payloadJson,
        payloadHash: await sha256Hex(entry.payloadJson),
        sizeBytes: entry.sizeBytes,
      };
    }),
  );
  const outcome = store.append(
    {
      version: append.expectedVersion,
      lastOrdinal: append.expectedLastOrdinal,
    },
    prepared,
    Date.now(),
  );
  switch (outcome.kind) {
    case "appended":
      return jsonResponse(200, {
        version: outcome.head.version,
        lastOrdinal: outcome.head.lastOrdinal,
      });
    case "replayed":
      return jsonResponse(200, {
        version: outcome.head.version,
        lastOrdinal: outcome.head.lastOrdinal,
        replayed: true,
      });
    case "head-conflict":
      return jsonResponse(409, {
        error: "head_conflict",
        version: outcome.head.version,
        lastOrdinal: outcome.head.lastOrdinal,
      });
    case "message-conflict":
      return jsonResponse(409, {
        error: "message_conflict",
        messageId: outcome.messageId,
      });
  }
}

export async function handleThreadRequest(
  store: ThreadStore,
  request: Request,
): Promise<Response> {
  const auth = parseAuthHeader(request);
  if (!auth) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/messages") {
    return handleRead(store, auth);
  }
  if (request.method === "POST" && url.pathname === "/v1/messages/append") {
    return handleAppend(store, auth, request);
  }
  return jsonResponse(404, { error: "not_found" });
}
