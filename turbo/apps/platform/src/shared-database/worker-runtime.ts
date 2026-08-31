import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import type { IDBPDatabase } from "idb";

import {
  captureSentryLogError,
  sentryLogContext,
} from "../lib/sentry-config.ts";
import { now } from "../lib/time.ts";
import { createChatIdbOpener } from "../signals/external/chat-idb-opener.ts";
import { createIdbEventRowStores } from "../signals/external/idb-event-row-store.ts";
import { createStrictIdbChatThreadEventStores } from "../signals/external/idb-chat-thread-event-store.ts";
import { logger } from "../signals/log.ts";
import { isAbortError, settle } from "../signals/utils.ts";
import {
  scopeSharedDatabaseDataKey,
  type ChatEventDataKey,
  type ChatThreadEventDataKey,
  type ChatThreadEventQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
  type ScopedChatEventDataKey,
  type ScopedChatThreadEventDataKey,
  type ScopedSharedDatabaseDataKey,
} from "./data-key.ts";
import { CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD } from "./event-log-policy.ts";
import {
  assertChatEventSchemaVersion,
  CHAT_EVENT_SCHEMA_VERSION_HEADERS,
} from "./chat-event-schema-version.ts";
import {
  SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME,
  type SharedDatabaseHeartbeatResult,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import type {
  SharedDatabaseContractClient,
  SharedDatabaseContractClientFactory,
} from "./worker-client.ts";

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const L = logger("SharedDatabaseWorker");

function chatEventRowsQuery(cursor: ChatEventCursor) {
  return cursor.lastEventId === null
    ? {
        sinceSeqId: cursor.lastSeqId,
        limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
      }
    : {
        sinceSeqId: cursor.lastSeqId,
        sinceEventId: cursor.lastEventId,
        limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
      };
}

type WorkerRuntimeEvent = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type: "authentication-required" | "reload-required" | "status";
  }
>;

interface CredentialState {
  readonly userId: string;
  readonly orgId: string;
  token: string;
  apiBaseUrl: string;
  vercelProtectionBypass: string | undefined;
  authBlocked: boolean;
  rejectedToken: string | null;
}

type ChatEventContractClient = SharedDatabaseContractClient<
  typeof chatThreadEventsContract
>;

interface ChatEventRemoteState {
  readonly remoteRows: readonly ChatEventRow[];
  readonly cursor: ChatEventCursor;
  readonly cursorFromServer: boolean;
  readonly needsColdStartTailConfirmation: boolean;
  readonly replacedCache: boolean;
}

interface ChatEventRemoteContext {
  readonly client: ChatEventContractClient;
  readonly dataKey: ScopedChatEventDataKey;
  readonly requestToken: string;
}

interface ChatThreadEventRemoteState {
  readonly result: ChatThreadEventQueryResult;
  readonly cursor: { readonly eventId: string; readonly seqId: number } | null;
  readonly replacement: boolean;
  readonly cursorFromServerSnapshot: boolean;
  readonly newEvents: readonly ChatThreadEvent[];
}

interface ChatThreadEventRemoteContext {
  readonly client: SharedDatabaseContractClient<typeof chatThreadsContract>;
  readonly requestToken: string;
}

interface ChatDatabaseEntry {
  readonly promise: Promise<IDBPDatabase>;
  database: IDBPDatabase | null;
  invalidated: boolean;
}

interface ChatThreadEventCache {
  readonly result: ChatThreadEventQueryResult;
  readonly degraded: boolean;
}

class SharedDatabaseAuthBlockedError extends Error {
  constructor() {
    super(
      "Shared database remote synchronization is blocked by authentication",
    );
    this.name = SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME;
  }
}

class SharedDatabaseHttpError extends Error {
  constructor(readonly status: number) {
    super(`Shared database request failed with status ${status}`);
    this.name = "SharedDatabaseHttpError";
  }
}

function dataKeyDiagnosticDetails(dataKey: ScopedSharedDatabaseDataKey): {
  readonly dataset: ScopedSharedDatabaseDataKey["kind"];
  readonly orgId: string;
  readonly userId: string;
} {
  return {
    dataset: dataKey.kind,
    orgId: dataKey.orgId,
    userId: dataKey.userId,
  };
}

function reportDataKeyError(
  dataKey: ScopedSharedDatabaseDataKey,
  operation: string,
  error: unknown,
): void {
  if (isAbortError(error) || error instanceof SharedDatabaseAuthBlockedError) {
    L.debug(operation, { ...dataKeyDiagnosticDetails(dataKey), error });
    return;
  }
  const details = dataKeyDiagnosticDetails(dataKey);
  const context = sentryLogContext({
    contexts: {
      shared_database: { org_id: dataKey.orgId },
      ...(error instanceof SharedDatabaseHttpError
        ? { response: { status_code: error.status } }
        : {}),
    },
    tags: {
      "shared_database.dataset": dataKey.kind,
      "shared_database.operation": operation,
    },
    user: { id: dataKey.userId },
  });
  L.debug(operation, { ...details, error });
  captureSentryLogError("SharedDatabaseWorker", [
    operation,
    error,
    details,
    context,
  ]);
}

function mergeChatEventRows(
  rowSets: readonly (readonly ChatEventRow[])[],
): ChatEventRow[] {
  const byId = new Map<string, ChatEventRow>();
  for (const rows of rowSets) {
    for (const row of rows) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

function chatThreadEventCursor(
  result: ChatThreadEventQueryResult,
): { readonly eventId: string; readonly seqId: number } | null {
  const event = result.events.at(-1);
  if (event) {
    return { eventId: event.id, seqId: event.seqId };
  }
  const snapshot = result.snapshot;
  if (
    !snapshot ||
    snapshot.latestEventId === null ||
    snapshot.latestSeqId === null
  ) {
    return null;
  }
  return {
    eventId: snapshot.latestEventId,
    seqId: snapshot.latestSeqId,
  };
}

export class SharedDatabaseWorkerRuntime {
  private readonly credential: CredentialState;
  private databaseEntry: ChatDatabaseEntry | null = null;

  constructor(
    identity: SharedDatabaseIdentity,
    apiBaseUrl: string,
    vercelProtectionBypass: string | undefined,
    private readonly rootSignal: AbortSignal,
    private readonly emit: (message: WorkerRuntimeEvent) => void,
    private readonly createContractClient: SharedDatabaseContractClientFactory,
  ) {
    this.credential = {
      userId: identity.userId,
      orgId: identity.orgId,
      token: identity.token,
      apiBaseUrl,
      vercelProtectionBypass,
      authBlocked: false,
      rejectedToken: null,
    };
    rootSignal.addEventListener(
      "abort",
      () => {
        L.debug("runtime.abort", {
          orgId: this.credential.orgId,
          userId: this.credential.userId,
        });
        this.databaseEntry?.database?.close();
        this.databaseEntry = null;
      },
      { once: true },
    );
  }

  heartbeat(
    identity: SharedDatabaseIdentity,
    apiBaseUrl: string,
    vercelProtectionBypass: string | undefined,
  ): SharedDatabaseHeartbeatResult {
    this.rootSignal.throwIfAborted();
    if (
      identity.userId !== this.credential.userId ||
      identity.orgId !== this.credential.orgId
    ) {
      throw new Error("Shared database heartbeat changed credential Store");
    }

    const resumesAuthentication =
      this.credential.authBlocked &&
      identity.token !== this.credential.rejectedToken;
    this.credential.apiBaseUrl = apiBaseUrl;
    this.credential.vercelProtectionBypass = vercelProtectionBypass;
    if (!this.credential.authBlocked || resumesAuthentication) {
      this.credential.token = identity.token;
    }
    if (resumesAuthentication) {
      L.debug("auth.resume", {
        orgId: identity.orgId,
        userId: identity.userId,
      });
      this.credential.authBlocked = false;
      this.credential.rejectedToken = null;
    }
    return { clientReconnected: false };
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    signal.throwIfAborted();
    const dataKey = scopeSharedDatabaseDataKey(query.dataKey, this.credential);
    const startedAt = now();
    const result = await settle(this.queryData(query, dataKey, signal), signal);
    if (!result.ok) {
      reportDataKeyError(dataKey, "query.error", result.error);
      throw result.error;
    }
    L.debug("query.finish", {
      ...dataKeyDiagnosticDetails(dataKey),
      durationMs: now() - startedAt,
    });
    return result.value;
  }

  private async queryData<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    dataKey: ScopedSharedDatabaseDataKey,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    if (query.dataKey.kind === "chat-event" && dataKey.kind === "chat-event") {
      const result = await this.queryChatEvents(
        dataKey,
        query.afterSeqId,
        query.consistency,
        signal,
      );
      return result as SharedDatabaseQueryResult<TKey>;
    }
    if (dataKey.kind !== "chat-thread-event") {
      throw new Error("Shared database query data key is invalid");
    }
    const result = await this.queryChatThreadEvents(
      dataKey,
      query.consistency,
      signal,
    );
    return result as SharedDatabaseQueryResult<TKey>;
  }

  private async queryChatEvents(
    dataKey: ScopedChatEventDataKey,
    afterSeqId: number | null,
    consistency: SharedDatabaseQuery<ChatEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    if (consistency === "cache-only") {
      return await this.readChatEventCache(dataKey, afterSeqId, signal);
    }
    this.requireRemoteSynchronization();
    const remoteRows = await this.syncChatEvents(dataKey, signal);
    signal.throwIfAborted();
    const cached = await this.readChatEventCache(dataKey, afterSeqId, signal);
    const requestedRemoteRows = remoteRows.filter((row) => {
      return afterSeqId === null || row.seqId > afterSeqId;
    });
    return mergeChatEventRows([cached, requestedRemoteRows]);
  }

  private async queryChatThreadEvents(
    dataKey: ScopedChatThreadEventDataKey,
    consistency: SharedDatabaseQuery<ChatThreadEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    if (consistency === "cache-only") {
      return (await this.readChatThreadEventCache(dataKey, signal)).result;
    }
    this.requireRemoteSynchronization();
    return await this.syncChatThreadEvents(dataKey, signal);
  }

  private async syncChatEvents(
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[]> {
    const stores = createIdbEventRowStores(() => {
      return this.getDatabase(signal);
    });
    const cachedCursorResult = await settle(
      stores.readStore.readCursor(dataKey.threadId, signal),
      signal,
    );
    const cachedCursor = cachedCursorResult.ok
      ? cachedCursorResult.value
      : null;
    if (!cachedCursorResult.ok) {
      reportDataKeyError(
        dataKey,
        "indexeddb.chat-event-cursor.read.error",
        cachedCursorResult.error,
      );
    }

    const requestToken = this.credential.token;
    const client = this.createContractClient(
      chatThreadEventsContract,
      this.credential.apiBaseUrl,
      () => {
        return requestToken;
      },
      () => {
        return this.credential.vercelProtectionBypass;
      },
    );

    let state: ChatEventRemoteState = {
      remoteRows: [],
      cursor: cachedCursor ?? {
        lastEventId: null,
        lastSeqId: THREAD_START_SEQ_ID,
      },
      cursorFromServer: false,
      needsColdStartTailConfirmation: false,
      replacedCache: false,
    };

    if (cachedCursor === null || !cachedCursorResult.ok) {
      const snapshot = await this.fetchChatEventSnapshot(
        client,
        dataKey,
        requestToken,
        signal,
      );
      state = {
        remoteRows: snapshot.rows,
        cursor: snapshot.cursor,
        cursorFromServer: true,
        needsColdStartTailConfirmation: true,
        replacedCache: true,
      };
    }
    state = await this.fetchChatEventRows(
      { client, dataKey, requestToken },
      state,
      signal,
    );
    await this.persistChatEventRows(stores, dataKey, state, signal);
    return state.remoteRows;
  }

  private async persistChatEventRows(
    stores: ReturnType<typeof createIdbEventRowStores>,
    dataKey: ScopedChatEventDataKey,
    state: ChatEventRemoteState,
    signal: AbortSignal,
  ): Promise<void> {
    if (!state.replacedCache && state.remoteRows.length === 0) {
      return;
    }
    const write = state.replacedCache
      ? stores.writeStore.replaceRowsAndCursor(
          dataKey.threadId,
          state.remoteRows,
          state.cursor,
          signal,
        )
      : stores.writeStore.upsertRowsAndCursor(
          dataKey.threadId,
          state.remoteRows,
          state.cursor,
          signal,
        );
    const written = await settle(write, signal);
    if (!written.ok) {
      reportDataKeyError(
        dataKey,
        "indexeddb.chat-event.write.error",
        written.error,
      );
    }
  }

  private async fetchChatEventRows(
    context: ChatEventRemoteContext,
    initialState: ChatEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatEventRemoteState> {
    const { client, dataKey, requestToken } = context;
    let remoteRows = [...initialState.remoteRows];
    let cursor = initialState.cursor;
    let cursorFromServer = initialState.cursorFromServer;
    let needsColdStartTailConfirmation =
      initialState.needsColdStartTailConfirmation;
    let replacedCache = initialState.replacedCache;
    let loadNextPage = true;
    while (loadNextPage) {
      const page = await client.rows({
        headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
        params: { threadId: dataKey.threadId },
        query: chatEventRowsQuery(cursor),
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(requestToken);
        throw new SharedDatabaseAuthBlockedError();
      }
      assertChatEventSchemaVersion(page.headers);
      if (page.status === 410) {
        if (cursorFromServer) {
          throw new Error(
            "ChatEvent cursor expired immediately after a server snapshot",
          );
        }
        const snapshot = await this.fetchChatEventSnapshot(
          client,
          dataKey,
          requestToken,
          signal,
        );
        remoteRows = [...snapshot.rows];
        cursor = snapshot.cursor;
        cursorFromServer = true;
        needsColdStartTailConfirmation = true;
        replacedCache = true;
        continue;
      }
      if (page.status !== 200) {
        throw new SharedDatabaseHttpError(page.status);
      }
      remoteRows = mergeChatEventRows([remoteRows, page.body.rows]);
      cursor = page.body.cursor;
      const confirmColdStartTail = needsColdStartTailConfirmation;
      needsColdStartTailConfirmation = false;
      loadNextPage = confirmColdStartTail || page.body.hasMore;
    }
    return {
      remoteRows,
      cursor,
      cursorFromServer,
      needsColdStartTailConfirmation,
      replacedCache,
    };
  }

  private async fetchChatEventSnapshot(
    client: ChatEventContractClient,
    dataKey: ScopedChatEventDataKey,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<{
    readonly rows: readonly ChatEventRow[];
    readonly cursor: ChatEventCursor;
  }> {
    const snapshot = await client.snapshot({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId: dataKey.threadId },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    if (snapshot.status === 401) {
      this.blockCredential(requestToken);
      throw new SharedDatabaseAuthBlockedError();
    }
    assertChatEventSchemaVersion(snapshot.headers);
    if (snapshot.status === 404) {
      return {
        rows: [],
        cursor: { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID },
      };
    }
    if (snapshot.status !== 200) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    const response = await fetch(snapshot.body.url, { signal });
    if (!response.ok) {
      throw new SharedDatabaseHttpError(response.status);
    }
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length > 0 && !text.endsWith("\n")) {
      throw new Error("ChatEvent snapshot must be newline-delimited JSON");
    }
    const rows =
      text.length === 0
        ? []
        : text
            .slice(0, -1)
            .split("\n")
            .map((line) => {
              const parsed: unknown = JSON.parse(line);
              return chatEventRowSchema.parse(parsed);
            });
    return {
      rows,
      cursor:
        snapshot.body.lastEventId === null
          ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
          : {
              lastEventId: snapshot.body.lastEventId,
              lastSeqId: snapshot.body.lastSeqId,
            },
    };
  }

  private async syncChatThreadEvents(
    dataKey: ScopedChatThreadEventDataKey,
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    const cached = await this.readChatThreadEventCache(dataKey, signal);
    const requestToken = this.credential.token;
    const client = this.createContractClient(
      chatThreadsContract,
      this.credential.apiBaseUrl,
      () => {
        return requestToken;
      },
      () => {
        return this.credential.vercelProtectionBypass;
      },
    );
    const cachedCursor = chatThreadEventCursor(cached.result);
    let state: ChatThreadEventRemoteState = {
      result: cached.result,
      cursor: cachedCursor,
      replacement: false,
      cursorFromServerSnapshot: false,
      newEvents: [],
    };

    if (
      cached.result.snapshot === null ||
      cachedCursor === null ||
      cached.degraded
    ) {
      const result = {
        snapshot: await this.fetchChatThreadSnapshot(
          client,
          requestToken,
          signal,
        ),
        events: [],
      };
      state = {
        result,
        cursor: chatThreadEventCursor(result),
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      };
    }

    const remoteContext = { client, requestToken };
    state = await this.loadChatThreadEventTail(remoteContext, state, signal);
    state = await this.maybeRebaseChatThreadEventSnapshot(
      dataKey,
      remoteContext,
      state,
      signal,
    );

    const shouldWrite = state.replacement || state.newEvents.length > 0;
    if (shouldWrite) {
      const stores = createStrictIdbChatThreadEventStores(() => {
        return this.getDatabase(signal);
      });
      const snapshot = state.result.snapshot;
      if (!snapshot) {
        throw new Error("ChatThreadEvent synchronization requires a snapshot");
      }
      const write = state.replacement
        ? stores.writeStore.replaceFromSnapshot(
            {
              chatThreads: snapshot.chatThreads,
              latestEventId: snapshot.latestEventId,
              latestSeqId: snapshot.latestSeqId,
            },
            state.result.events,
            signal,
          )
        : stores.writeStore.upsertEvents(state.newEvents, signal);
      const written = await settle(write, signal);
      if (!written.ok) {
        reportDataKeyError(
          dataKey,
          "indexeddb.chat-thread-event.write.error",
          written.error,
        );
      }
    }
    return state.result;
  }

  private async loadChatThreadEventTail(
    context: ChatThreadEventRemoteContext,
    initialState: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    const { client, requestToken } = context;
    let state = initialState;
    let hasMore = true;
    while (hasMore) {
      const page = await client.events({
        query: state.cursor ? { sinceSeqId: state.cursor.seqId } : {},
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(requestToken);
        throw new SharedDatabaseAuthBlockedError();
      }
      if (page.status === 410) {
        if (state.cursorFromServerSnapshot) {
          throw new Error(
            "ChatThreadEvent cursor expired immediately after a server snapshot",
          );
        }
        const result = {
          snapshot: await this.fetchChatThreadSnapshot(
            client,
            requestToken,
            signal,
          ),
          events: [],
        };
        state = {
          result,
          cursor: chatThreadEventCursor(result),
          replacement: true,
          cursorFromServerSnapshot: true,
          newEvents: [],
        };
        continue;
      }
      if (page.status !== 200) {
        throw new SharedDatabaseHttpError(page.status);
      }
      const pageEvents = page.body.events.filter((event) => {
        return state.cursor === null || event.seqId > state.cursor.seqId;
      });
      if (pageEvents.length > 0) {
        const lastEvent = pageEvents.at(-1)!;
        state = {
          result: {
            snapshot: state.result.snapshot,
            events: [...state.result.events, ...pageEvents],
          },
          cursor: { eventId: lastEvent.id, seqId: lastEvent.seqId },
          replacement: state.replacement,
          cursorFromServerSnapshot: false,
          newEvents: [...state.newEvents, ...pageEvents],
        };
      }
      hasMore = page.body.hasMore && page.body.events.length > 0;
    }
    return state;
  }

  private async maybeRebaseChatThreadEventSnapshot(
    dataKey: ScopedChatThreadEventDataKey,
    context: ChatThreadEventRemoteContext,
    state: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    if (
      state.replacement ||
      state.result.events.length <=
        CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD
    ) {
      return state;
    }
    const rebasedSnapshot = await settle(
      this.fetchChatThreadSnapshot(
        context.client,
        context.requestToken,
        signal,
      ),
      signal,
    );
    if (!rebasedSnapshot.ok) {
      if (this.credential.authBlocked) {
        throw rebasedSnapshot.error;
      }
      L.debug("snapshot-rebase.skip", {
        ...dataKeyDiagnosticDetails(dataKey),
        error: rebasedSnapshot.error,
      });
      return state;
    }
    const result = { snapshot: rebasedSnapshot.value, events: [] };
    return await this.loadChatThreadEventTail(
      context,
      {
        result,
        cursor: chatThreadEventCursor(result),
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      },
      signal,
    );
  }

  private async fetchChatThreadSnapshot(
    client: SharedDatabaseContractClient<typeof chatThreadsContract>,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<NonNullable<ChatThreadEventQueryResult["snapshot"]>> {
    const snapshot = await client.snapshot({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (snapshot.status === 401) {
      this.blockCredential(requestToken);
      throw new SharedDatabaseAuthBlockedError();
    }
    if (snapshot.status !== 200) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    return snapshot.body;
  }

  private async readChatEventCache(
    dataKey: ScopedChatEventDataKey,
    afterSeqId: number | null,
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    const stores = createIdbEventRowStores(() => {
      return this.getDatabase(signal);
    });
    const result = await settle(
      stores.readStore.readRowsAfter(dataKey.threadId, afterSeqId, signal),
      signal,
    );
    if (!result.ok) {
      reportDataKeyError(
        dataKey,
        "indexeddb.chat-event.read.error",
        result.error,
      );
      return [];
    }
    return result.value;
  }

  private async readChatThreadEventCache(
    dataKey: ScopedChatThreadEventDataKey,
    signal: AbortSignal,
  ): Promise<ChatThreadEventCache> {
    const stores = createStrictIdbChatThreadEventStores(() => {
      return this.getDatabase(signal);
    });
    const result = await settle(
      Promise.all([
        stores.readStore.readSnapshot(signal),
        stores.readStore.readEventLog(signal),
      ]),
      signal,
    );
    if (!result.ok) {
      reportDataKeyError(
        dataKey,
        "indexeddb.chat-thread-event.read.error",
        result.error,
      );
      return {
        result: { snapshot: null, events: [] },
        degraded: true,
      };
    }
    const [snapshot, eventLog] = result.value;
    return {
      result: {
        snapshot:
          snapshot === null
            ? null
            : {
                chatThreads: [...snapshot.chatThreads],
                latestEventId: snapshot.latestEventId,
                latestSeqId: snapshot.latestSeqId,
              },
        events: [...eventLog.events],
      },
      degraded: false,
    };
  }

  private async getDatabase(signal: AbortSignal): Promise<IDBPDatabase> {
    let entry = this.databaseEntry;
    if (!entry) {
      const opener = createChatIdbOpener({
        reload: () => {
          if (this.databaseEntry) {
            this.databaseEntry.invalidated = true;
          }
          this.emit({ type: "reload-required" });
        },
      });
      const nextEntry: ChatDatabaseEntry = {
        promise: opener.openChatIdb(
          this.credential.userId,
          this.credential.orgId,
        ),
        database: null,
        invalidated: false,
      };
      entry = nextEntry;
      this.databaseEntry = entry;
    }
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    const database = await entry.promise;
    signal.throwIfAborted();
    entry.database ??= database;
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    return database;
  }

  private blockCredential(rejectedToken: string): void {
    if (
      this.credential.token !== rejectedToken ||
      this.credential.authBlocked
    ) {
      return;
    }
    L.debug("auth.block", {
      orgId: this.credential.orgId,
      userId: this.credential.userId,
    });
    this.credential.authBlocked = true;
    this.credential.rejectedToken = rejectedToken;
    this.emit({ type: "authentication-required" });
    this.emit({ type: "status", status: "disconnected" });
  }

  private requireRemoteSynchronization(): void {
    if (this.credential.authBlocked) {
      throw new SharedDatabaseAuthBlockedError();
    }
  }
}
