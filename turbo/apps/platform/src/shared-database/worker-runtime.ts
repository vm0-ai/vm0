import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import type { InboundMessage, TokenRequest } from "ably";
import type { IDBPDatabase } from "idb";
import { now } from "../lib/time.ts";
import { createChatIdbOpener } from "../signals/external/chat-idb-store.ts";
import { createIdbEventRowStores } from "../signals/external/idb-event-row-store.ts";
import { createStrictIdbChatThreadEventStores } from "../signals/external/idb-chat-thread-event-store.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  Reason,
  settle,
  withCleanup,
} from "../signals/utils.ts";
import {
  sharedDatabaseCredentialId,
  sharedDatabaseDataKeyId,
  type ChatEventDataKey,
  type ChatThreadEventDataKey,
  type ChatThreadEventQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
} from "./data-key.ts";
import type {
  SharedDatabaseConnectionStatus,
  SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import { createSharedDatabaseContractClient } from "./worker-client.ts";
import {
  createSharedDatabaseRealtimeSession,
  type SharedDatabaseRealtimeSession,
} from "./worker-realtime.ts";

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const STALE_CLIENT_AFTER_MS = 3 * 60 * 1000;

type WorkerClientEvent = Extract<
  SharedDatabaseWorkerMessage,
  {
    readonly type: "append" | "reload-required" | "status";
  }
>;

export type WorkerClientEmitter = (event: WorkerClientEvent) => void;

interface WorkerClientRegistration {
  readonly clientId: string;
  readonly emit: WorkerClientEmitter;
  readonly subscriptions: Map<string, SharedDatabaseDataKey>;
  identity: SharedDatabaseIdentity | null;
  apiBaseUrl: string | null;
  lastHeartbeatAt: number;
}

interface CredentialState {
  readonly userId: string;
  readonly orgId: string;
  token: string;
  apiBaseUrl: string;
  authBlocked: boolean;
  rejectedToken: string | null;
  updatedAt: number;
  readonly dirtyDataKeyIds: Set<string>;
}

interface ChatEventSyncResult {
  readonly remoteRows: readonly ChatEventRow[];
  readonly changed: boolean;
}

interface ChatThreadEventSyncResult {
  readonly result: ChatThreadEventQueryResult;
  readonly changed: boolean;
}

interface ChatEventActor {
  readonly kind: "chat-event";
  readonly dataKey: ChatEventDataKey;
  degraded: boolean;
  invalidationPending: boolean;
  inFlight: Promise<ChatEventSyncResult> | null;
}

interface ChatThreadEventActor {
  readonly kind: "chat-thread-event";
  readonly dataKey: ChatThreadEventDataKey;
  degraded: boolean;
  invalidationPending: boolean;
  inFlight: Promise<ChatThreadEventSyncResult> | null;
}

type DatasetActor = ChatEventActor | ChatThreadEventActor;

interface ChatDatabaseEntry {
  readonly promise: Promise<IDBPDatabase>;
  database: IDBPDatabase | null;
  invalidated: boolean;
}

class SharedDatabaseAuthBlockedError extends Error {
  constructor() {
    super(
      "Shared database remote synchronization is blocked by authentication",
    );
    this.name = "SharedDatabaseAuthBlockedError";
  }
}

class SharedDatabaseHttpError extends Error {
  constructor(status: number) {
    super(`Shared database request failed with status ${status}`);
    this.name = "SharedDatabaseHttpError";
  }
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
  if (snapshot?.latestEventId === null || snapshot?.latestSeqId === null) {
    return null;
  }
  if (!snapshot) {
    return null;
  }
  return {
    eventId: snapshot.latestEventId,
    seqId: snapshot.latestSeqId,
  };
}

function waitForSharedWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const waitController = createChildAbortController(signal);
  const aborted = createDeferredPromise<never>(waitController.signal);
  return withCleanup(Promise.race([work, aborted.promise]), () => {
    waitController.abort(
      new DOMException("Shared database wait completed", "AbortError"),
    );
  });
}

export class SharedDatabaseWorkerRuntime {
  private readonly clients = new Map<string, WorkerClientRegistration>();
  private readonly credentials = new Map<string, CredentialState>();
  private readonly actors = new Map<string, DatasetActor>();
  private readonly databases = new Map<string, ChatDatabaseEntry>();
  private readonly realtimeSessions = new Map<
    string,
    SharedDatabaseRealtimeSession
  >();
  private readonly realtimeStatuses = new Map<
    string,
    SharedDatabaseConnectionStatus
  >();

  constructor(private readonly rootSignal: AbortSignal) {
    rootSignal.addEventListener(
      "abort",
      () => {
        for (const session of this.realtimeSessions.values()) {
          session.close();
        }
        this.realtimeSessions.clear();
        this.realtimeStatuses.clear();
        for (const entry of this.databases.values()) {
          entry.database?.close();
        }
        this.databases.clear();
        this.actors.clear();
        this.credentials.clear();
        this.clients.clear();
      },
      { once: true },
    );
  }

  connectClient(clientId: string, emit: WorkerClientEmitter): void {
    this.rootSignal.throwIfAborted();
    if (this.clients.has(clientId)) {
      throw new Error("Shared database client is already connected");
    }
    this.clients.set(clientId, {
      clientId,
      emit,
      subscriptions: new Map(),
      identity: null,
      apiBaseUrl: null,
      lastHeartbeatAt: now(),
    });
    emit({ type: "status", status: "connecting" });
  }

  async heartbeat(
    clientId: string,
    identity: SharedDatabaseIdentity,
    apiBaseUrl: string,
  ): Promise<void> {
    this.rootSignal.throwIfAborted();
    this.pruneStaleClients();
    const client = this.requireClient(clientId);
    const previousCredentialId = client.identity
      ? sharedDatabaseCredentialId(client.identity)
      : null;
    const nextCredentialId = sharedDatabaseCredentialId(identity);
    if (
      previousCredentialId !== null &&
      previousCredentialId !== nextCredentialId
    ) {
      client.subscriptions.clear();
      this.removeUnusedActors();
      this.closeUnusedRealtimeSessions();
      this.releaseCredentialIfUnused(previousCredentialId);
    }
    client.identity = identity;
    client.apiBaseUrl = apiBaseUrl;
    client.lastHeartbeatAt = now();

    let credential = this.credentials.get(nextCredentialId);
    if (!credential) {
      credential = {
        userId: identity.userId,
        orgId: identity.orgId,
        token: identity.token,
        apiBaseUrl,
        authBlocked: false,
        rejectedToken: null,
        updatedAt: now(),
        dirtyDataKeyIds: new Set(),
      };
      this.credentials.set(nextCredentialId, credential);
    }

    const resumesAuthentication =
      credential.authBlocked && identity.token !== credential.rejectedToken;
    credential.apiBaseUrl = apiBaseUrl;
    credential.updatedAt = now();
    if (!credential.authBlocked || resumesAuthentication) {
      credential.token = identity.token;
    }
    if (resumesAuthentication) {
      credential.authBlocked = false;
      credential.rejectedToken = null;
      client.emit({ type: "status", status: "connecting" });
      this.restartRealtimeForUser(identity.userId);
      await this.catchUpDirtyActors(credential);
    }
    client.emit({
      type: "status",
      status: credential.authBlocked
        ? "disconnected"
        : this.realtimeStatusForUser(identity.userId),
    });
  }

  disconnectClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    const credentialId = client.identity
      ? sharedDatabaseCredentialId(client.identity)
      : null;
    client.subscriptions.clear();
    this.clients.delete(clientId);
    this.removeUnusedActors();
    this.closeUnusedRealtimeSessions();
    if (credentialId !== null) {
      this.releaseCredentialIfUnused(credentialId);
    }
  }

  subscribe(
    clientId: string,
    subscriptionId: string,
    dataKey: SharedDatabaseDataKey,
  ): void {
    const client = this.requireClientForDataKey(clientId, dataKey);
    client.subscriptions.set(subscriptionId, dataKey);
    this.getOrCreateActor(dataKey);
    this.ensureRealtimeForUser(dataKey.userId);
  }

  unsubscribe(clientId: string, subscriptionId: string): void {
    const client = this.clients.get(clientId);
    client?.subscriptions.delete(subscriptionId);
    this.removeUnusedActors();
    this.closeUnusedRealtimeSessions();
  }

  async query<TKey extends SharedDatabaseDataKey>(
    clientId: string,
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const client = this.requireClientForDataKey(clientId, query.dataKey);
    const credentialId = sharedDatabaseCredentialId(query.dataKey);
    const actor = this.getOrCreateActor(query.dataKey);
    const result = await withCleanup(
      this.queryActor(actor, query, signal),
      () => {
        this.removeUnusedActors();
      },
    );
    signal.throwIfAborted();
    if (
      client.identity === null ||
      sharedDatabaseCredentialId(client.identity) !== credentialId
    ) {
      throw new Error("Shared database identity changed during query");
    }
    return result;
  }

  private async queryActor<TKey extends SharedDatabaseDataKey>(
    actor: DatasetActor,
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    if (actor.kind === "chat-event") {
      const result = await this.queryChatEvents(
        actor,
        query.afterSeqId,
        query.consistency,
        signal,
      );
      return result as SharedDatabaseQueryResult<TKey>;
    }
    const result = await this.queryChatThreadEvents(
      actor,
      query.consistency,
      signal,
    );
    return result as SharedDatabaseQueryResult<TKey>;
  }

  private async queryChatEvents(
    actor: ChatEventActor,
    afterSeqId: number | null,
    consistency: SharedDatabaseQuery<ChatEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    if (consistency === "cache-only") {
      return await this.readChatEventCache(actor, afterSeqId, signal);
    }
    const credential = this.requireCredential(actor.dataKey);
    if (credential.authBlocked) {
      credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
      throw new SharedDatabaseAuthBlockedError();
    }
    const sync = await waitForSharedWork(
      this.ensureChatEventSync(actor, credential),
      signal,
    );
    const cached = await this.readChatEventCache(actor, afterSeqId, signal);
    const remoteRows = sync.remoteRows.filter((row) => {
      return afterSeqId === null || row.seqId > afterSeqId;
    });
    return mergeChatEventRows([cached, remoteRows]);
  }

  private async queryChatThreadEvents(
    actor: ChatThreadEventActor,
    consistency: SharedDatabaseQuery<ChatThreadEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    if (consistency === "cache-only") {
      return await this.readChatThreadEventCache(actor, signal);
    }
    const credential = this.requireCredential(actor.dataKey);
    if (credential.authBlocked) {
      credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
      throw new SharedDatabaseAuthBlockedError();
    }
    const sync = await waitForSharedWork(
      this.ensureChatThreadEventSync(actor, credential),
      signal,
    );
    return sync.result;
  }

  private ensureChatEventSync(
    actor: ChatEventActor,
    credential: CredentialState,
  ): Promise<ChatEventSyncResult> {
    if (actor.inFlight) {
      return actor.inFlight;
    }
    const inFlight = this.completeChatEventSync(actor, credential);
    actor.inFlight = inFlight;
    return inFlight;
  }

  private async completeChatEventSync(
    actor: ChatEventActor,
    credential: CredentialState,
  ): Promise<ChatEventSyncResult> {
    const [settled] = await Promise.allSettled([
      this.syncChatEvents(actor, credential, this.rootSignal),
    ]);
    actor.inFlight = null;
    const repeatAfterCurrentSync = actor.invalidationPending;
    actor.invalidationPending = false;
    if (settled?.status === "fulfilled") {
      credential.dirtyDataKeyIds.delete(sharedDatabaseDataKeyId(actor.dataKey));
      if (settled.value.changed) {
        this.notifyActor(actor.dataKey);
      }
      this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
      this.removeUnusedActors();
      return settled.value;
    }
    credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
    this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
    this.removeUnusedActors();
    throw settled?.reason;
  }

  private ensureChatThreadEventSync(
    actor: ChatThreadEventActor,
    credential: CredentialState,
  ): Promise<ChatThreadEventSyncResult> {
    if (actor.inFlight) {
      return actor.inFlight;
    }
    const inFlight = this.completeChatThreadEventSync(actor, credential);
    actor.inFlight = inFlight;
    return inFlight;
  }

  private async completeChatThreadEventSync(
    actor: ChatThreadEventActor,
    credential: CredentialState,
  ): Promise<ChatThreadEventSyncResult> {
    const [settled] = await Promise.allSettled([
      this.syncChatThreadEvents(actor, credential, this.rootSignal),
    ]);
    actor.inFlight = null;
    const repeatAfterCurrentSync = actor.invalidationPending;
    actor.invalidationPending = false;
    if (settled?.status === "fulfilled") {
      credential.dirtyDataKeyIds.delete(sharedDatabaseDataKeyId(actor.dataKey));
      if (settled.value.changed) {
        this.notifyActor(actor.dataKey);
      }
      this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
      this.removeUnusedActors();
      return settled.value;
    }
    credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
    this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
    this.removeUnusedActors();
    throw settled?.reason;
  }

  private repeatRealtimeCatchUp(
    actor: DatasetActor,
    credential: CredentialState,
    repeat: boolean,
  ): void {
    const actorId = sharedDatabaseDataKeyId(actor.dataKey);
    if (!repeat || credential.authBlocked || !this.isActorSubscribed(actorId)) {
      return;
    }
    const catchUp: Promise<unknown> =
      actor.kind === "chat-event"
        ? this.ensureChatEventSync(actor, credential)
        : this.ensureChatThreadEventSync(actor, credential);
    detach(
      settle(catchUp, this.rootSignal),
      Reason.Daemon,
      `shared database coalesced realtime catch-up: ${actorId}`,
    );
  }

  private async syncChatEvents(
    actor: ChatEventActor,
    credential: CredentialState,
    signal: AbortSignal,
  ): Promise<ChatEventSyncResult> {
    const stores = createIdbEventRowStores(() => {
      return this.getDatabase(actor.dataKey);
    });
    const cachedCursorResult = await settle(
      stores.readStore.readCursor(actor.dataKey.threadId, signal),
      signal,
    );
    const cachedCursor = cachedCursorResult.ok
      ? cachedCursorResult.value
      : null;
    if (!cachedCursorResult.ok) {
      actor.degraded = true;
    }

    const requestToken = credential.token;
    const client = createSharedDatabaseContractClient(
      chatThreadEventsContract,
      credential.apiBaseUrl,
      () => {
        return requestToken;
      },
    );

    let remoteRows: ChatEventRow[] = [];
    let cursor: ChatEventCursor = cachedCursor ?? {
      lastEventId: null,
      lastSeqId: THREAD_START_SEQ_ID,
    };
    let cursorFromServer = false;
    let needsColdStartTailConfirmation = false;
    let replacedCache = false;

    if (cachedCursor === null || actor.degraded) {
      const snapshot = await this.fetchChatEventSnapshot(
        client,
        actor.dataKey,
        credential,
        requestToken,
        signal,
      );
      remoteRows = [...snapshot.rows];
      cursor = snapshot.cursor;
      cursorFromServer = true;
      needsColdStartTailConfirmation = true;
      replacedCache = true;
    }

    let loadNextPage = true;
    while (loadNextPage) {
      const page = await client.rows({
        headers: {
          [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
            CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        },
        params: { threadId: actor.dataKey.threadId },
        query: {
          sinceSeqId: cursor.lastSeqId,
          sinceEventId: cursor.lastEventId ?? undefined,
          limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
        },
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(credential, requestToken);
        throw new SharedDatabaseAuthBlockedError();
      }
      if (page.status === 410) {
        if (cursorFromServer) {
          throw new Error(
            "ChatEvent cursor expired immediately after a server snapshot",
          );
        }
        const snapshot = await this.fetchChatEventSnapshot(
          client,
          actor.dataKey,
          credential,
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
      const pageRows = page.body.rows;
      remoteRows = mergeChatEventRows([remoteRows, pageRows]);
      const lastRow = pageRows.at(-1);
      if (lastRow) {
        cursor = { lastEventId: lastRow.id, lastSeqId: lastRow.seqId };
      }
      const confirmColdStartTail = needsColdStartTailConfirmation;
      needsColdStartTailConfirmation = false;
      loadNextPage =
        confirmColdStartTail || pageRows.length === CHAT_EVENT_ROWS_PAGE_LIMIT;
    }

    const shouldWrite = replacedCache || remoteRows.length > 0;
    if (shouldWrite) {
      const write = replacedCache
        ? stores.writeStore.replaceRowsAndCursor(
            actor.dataKey.threadId,
            remoteRows,
            cursor,
            signal,
          )
        : stores.writeStore.upsertRowsAndCursor(
            actor.dataKey.threadId,
            remoteRows,
            cursor,
            signal,
          );
      const written = await settle(write, signal);
      actor.degraded = !written.ok;
    }
    return {
      remoteRows,
      changed: shouldWrite,
    };
  }

  private async fetchChatEventSnapshot(
    client: ReturnType<
      typeof createSharedDatabaseContractClient<typeof chatThreadEventsContract>
    >,
    dataKey: ChatEventDataKey,
    credential: CredentialState,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<{
    readonly rows: readonly ChatEventRow[];
    readonly cursor: ChatEventCursor;
  }> {
    const snapshot = await client.snapshot({
      headers: {
        [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
      },
      params: { threadId: dataKey.threadId },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    if (snapshot.status === 401) {
      this.blockCredential(credential, requestToken);
      throw new SharedDatabaseAuthBlockedError();
    }
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
    if (text.length === 0 || !text.endsWith("\n")) {
      throw new Error("ChatEvent snapshot must be newline-delimited JSON");
    }
    const rows = text
      .slice(0, -1)
      .split("\n")
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        return chatEventRowSchema.parse(parsed);
      });
    return {
      rows,
      cursor: {
        lastEventId: snapshot.body.lastEventId ?? rows.at(-1)?.id ?? null,
        lastSeqId: snapshot.body.lastSeqId,
      },
    };
  }

  private async syncChatThreadEvents(
    actor: ChatThreadEventActor,
    credential: CredentialState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventSyncResult> {
    const cached = await this.readChatThreadEventCache(actor, signal);
    const requestToken = credential.token;
    const client = createSharedDatabaseContractClient(
      chatThreadsContract,
      credential.apiBaseUrl,
      () => {
        return requestToken;
      },
    );
    let result = cached;
    let cursor = chatThreadEventCursor(result);
    let replacement = false;
    let cursorFromServerSnapshot = false;
    let newEvents: ChatThreadEvent[] = [];

    if (result.snapshot === null || cursor === null || actor.degraded) {
      result = {
        snapshot: await this.fetchChatThreadSnapshot(
          client,
          credential,
          requestToken,
          signal,
        ),
        events: [],
      };
      cursor = chatThreadEventCursor(result);
      replacement = true;
      cursorFromServerSnapshot = true;
    }

    let hasMore = true;
    while (hasMore) {
      const page = await client.events({
        query: cursor ? { sinceSeqId: cursor.seqId } : {},
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(credential, requestToken);
        throw new SharedDatabaseAuthBlockedError();
      }
      if (page.status === 410) {
        if (cursorFromServerSnapshot) {
          throw new Error(
            "ChatThreadEvent cursor expired immediately after a server snapshot",
          );
        }
        result = {
          snapshot: await this.fetchChatThreadSnapshot(
            client,
            credential,
            requestToken,
            signal,
          ),
          events: [],
        };
        cursor = chatThreadEventCursor(result);
        newEvents = [];
        replacement = true;
        cursorFromServerSnapshot = true;
        continue;
      }
      if (page.status !== 200) {
        throw new SharedDatabaseHttpError(page.status);
      }
      const pageEvents = page.body.events.filter((event) => {
        return cursor === null || event.seqId > cursor.seqId;
      });
      if (pageEvents.length > 0) {
        result = {
          snapshot: result.snapshot,
          events: [...result.events, ...pageEvents],
        };
        newEvents.push(...pageEvents);
        const lastEvent = pageEvents.at(-1)!;
        cursor = { eventId: lastEvent.id, seqId: lastEvent.seqId };
        cursorFromServerSnapshot = false;
      }
      hasMore = page.body.hasMore && page.body.events.length > 0;
    }

    const shouldWrite = replacement || newEvents.length > 0;
    if (shouldWrite) {
      const stores = createStrictIdbChatThreadEventStores(() => {
        return this.getDatabase(actor.dataKey);
      });
      const snapshot = result.snapshot;
      if (!snapshot) {
        throw new Error("ChatThreadEvent synchronization requires a snapshot");
      }
      const write = replacement
        ? stores.writeStore.replaceFromSnapshot(
            {
              chatThreads: snapshot.chatThreads,
              latestEventId: snapshot.latestEventId,
              latestSeqId: snapshot.latestSeqId,
            },
            result.events,
            signal,
          )
        : stores.writeStore.upsertEvents(newEvents, signal);
      const written = await settle(write, signal);
      actor.degraded = !written.ok;
    }
    return { result, changed: shouldWrite };
  }

  private async fetchChatThreadSnapshot(
    client: ReturnType<
      typeof createSharedDatabaseContractClient<typeof chatThreadsContract>
    >,
    credential: CredentialState,
    requestToken: string,
    signal: AbortSignal,
  ): Promise<NonNullable<ChatThreadEventQueryResult["snapshot"]>> {
    const snapshot = await client.snapshot({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (snapshot.status === 401) {
      this.blockCredential(credential, requestToken);
      throw new SharedDatabaseAuthBlockedError();
    }
    if (snapshot.status !== 200) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    return snapshot.body;
  }

  private async readChatEventCache(
    actor: ChatEventActor,
    afterSeqId: number | null,
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    const stores = createIdbEventRowStores(() => {
      return this.getDatabase(actor.dataKey);
    });
    const result = await settle(
      stores.readStore.readRowsAfter(
        actor.dataKey.threadId,
        afterSeqId,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      actor.degraded = true;
      return [];
    }
    return result.value;
  }

  private async readChatThreadEventCache(
    actor: ChatThreadEventActor,
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    const stores = createStrictIdbChatThreadEventStores(() => {
      return this.getDatabase(actor.dataKey);
    });
    const result = await settle(
      Promise.all([
        stores.readStore.readSnapshot(signal),
        stores.readStore.readEventLog(signal),
      ]),
      signal,
    );
    if (!result.ok) {
      actor.degraded = true;
      return { snapshot: null, events: [] };
    }
    const [snapshot, eventLog] = result.value;
    return {
      snapshot:
        snapshot === null
          ? null
          : {
              chatThreads: [...snapshot.chatThreads],
              latestEventId: snapshot.latestEventId,
              latestSeqId: snapshot.latestSeqId,
            },
      events: [...eventLog.events],
    };
  }

  private async getDatabase(
    dataKey: SharedDatabaseDataKey,
  ): Promise<IDBPDatabase> {
    const credentialId = sharedDatabaseCredentialId(dataKey);
    let entry = this.databases.get(credentialId);
    if (!entry) {
      const opener = createChatIdbOpener({
        reload: () => {
          const current = this.databases.get(credentialId);
          if (current) {
            current.invalidated = true;
          }
          this.notifyReloadRequired(dataKey.userId, dataKey.orgId);
        },
      });
      const nextEntry: ChatDatabaseEntry = {
        promise: (async () => {
          const database = await opener.openChatIdb(
            dataKey.userId,
            dataKey.orgId,
          );
          return database;
        })(),
        database: null,
        invalidated: false,
      };
      entry = nextEntry;
      this.databases.set(credentialId, entry);
    }
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    const database = await entry.promise;
    entry.database ??= database;
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    return database;
  }

  private getOrCreateActor(dataKey: SharedDatabaseDataKey): DatasetActor {
    const id = sharedDatabaseDataKeyId(dataKey);
    const existing = this.actors.get(id);
    if (existing) {
      return existing;
    }
    const actor: DatasetActor =
      dataKey.kind === "chat-event"
        ? {
            kind: "chat-event",
            dataKey,
            degraded: false,
            invalidationPending: false,
            inFlight: null,
          }
        : {
            kind: "chat-thread-event",
            dataKey,
            degraded: false,
            invalidationPending: false,
            inFlight: null,
          };
    this.actors.set(id, actor);
    return actor;
  }

  private requireClient(clientId: string): WorkerClientRegistration {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error("Shared database client is not connected");
    }
    return client;
  }

  private requireClientForDataKey(
    clientId: string,
    dataKey: SharedDatabaseDataKey,
  ): WorkerClientRegistration {
    const client = this.requireClient(clientId);
    if (
      client.identity === null ||
      client.identity.userId !== dataKey.userId ||
      client.identity.orgId !== dataKey.orgId
    ) {
      throw new Error(
        "Shared database data key does not match client identity",
      );
    }
    return client;
  }

  private requireCredential(dataKey: SharedDatabaseDataKey): CredentialState {
    const credential = this.credentials.get(
      sharedDatabaseCredentialId(dataKey),
    );
    if (!credential) {
      throw new Error("Shared database heartbeat is required before query");
    }
    return credential;
  }

  private blockCredential(
    credential: CredentialState,
    rejectedToken: string,
  ): void {
    if (credential.token !== rejectedToken) {
      return;
    }
    credential.authBlocked = true;
    credential.rejectedToken = rejectedToken;
    for (const [id, actor] of this.actors) {
      if (
        actor.dataKey.userId === credential.userId &&
        actor.dataKey.orgId === credential.orgId
      ) {
        credential.dirtyDataKeyIds.add(id);
      }
    }
    for (const client of this.clients.values()) {
      if (
        client.identity?.userId === credential.userId &&
        client.identity.orgId === credential.orgId
      ) {
        client.emit({ type: "status", status: "disconnected" });
      }
    }
  }

  private async catchUpDirtyActors(credential: CredentialState): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const id of credential.dirtyDataKeyIds) {
      const actor = this.actors.get(id);
      if (!actor) {
        credential.dirtyDataKeyIds.delete(id);
        continue;
      }
      if (actor.inFlight === null) {
        actor.invalidationPending = false;
      }
      work.push(
        actor.kind === "chat-event"
          ? this.ensureChatEventSync(actor, credential)
          : this.ensureChatThreadEventSync(actor, credential),
      );
    }
    await Promise.all(work);
  }

  private notifyActor(dataKey: SharedDatabaseDataKey): void {
    const id = sharedDatabaseDataKeyId(dataKey);
    for (const client of this.clients.values()) {
      for (const [
        subscriptionId,
        subscriptionDataKey,
      ] of client.subscriptions) {
        if (sharedDatabaseDataKeyId(subscriptionDataKey) === id) {
          client.emit({
            type: "append",
            subscriptionId,
            dataKey,
          });
        }
      }
    }
  }

  private notifyReloadRequired(userId: string, orgId: string): void {
    for (const client of this.clients.values()) {
      if (
        client.identity?.userId === userId &&
        client.identity.orgId === orgId
      ) {
        client.emit({ type: "reload-required" });
      }
    }
  }

  private ensureRealtimeForUser(userId: string): void {
    if (this.realtimeSessions.has(userId)) {
      return;
    }
    this.realtimeStatuses.set(userId, "connecting");
    this.broadcastRealtimeStatus(userId, "connecting");
    const session = createSharedDatabaseRealtimeSession(
      {
        userId,
        getTokenRequest: async () => {
          return await this.fetchRealtimeTokenRequest(userId);
        },
        onMessage: (message) => {
          this.handleRealtimeMessage(userId, message);
        },
        onStatus: (status) => {
          this.realtimeStatuses.set(userId, status);
          this.broadcastRealtimeStatus(userId, status);
        },
      },
      this.rootSignal,
    );
    this.realtimeSessions.set(userId, session);
  }

  private async fetchRealtimeTokenRequest(
    userId: string,
  ): Promise<TokenRequest> {
    const credential = Array.from(this.credentials.values())
      .filter((candidate) => {
        return candidate.userId === userId && !candidate.authBlocked;
      })
      .sort((left, right) => {
        return left.updatedAt - right.updatedAt;
      })
      .at(-1);
    if (!credential) {
      throw new SharedDatabaseAuthBlockedError();
    }
    const requestToken = credential.token;
    const client = createSharedDatabaseContractClient(
      platformRealtimeTokenContract,
      credential.apiBaseUrl,
      () => {
        return requestToken;
      },
    );
    const result = await client.create({ body: {} });
    if (result.status === 401) {
      this.blockCredential(credential, requestToken);
      throw new SharedDatabaseAuthBlockedError();
    }
    if (result.status !== 200) {
      throw new SharedDatabaseHttpError(result.status);
    }
    return result.body;
  }

  private handleRealtimeMessage(userId: string, message: InboundMessage): void {
    const topic = message.name ?? "";
    const threadId = topic.startsWith("chatThreadMessageCreated:")
      ? topic.slice("chatThreadMessageCreated:".length)
      : null;
    for (const [id, actor] of this.actors) {
      const matches =
        actor.dataKey.userId === userId &&
        ((actor.kind === "chat-thread-event" &&
          topic === "threadListChanged") ||
          (actor.kind === "chat-event" &&
            threadId !== null &&
            actor.dataKey.threadId === threadId));
      if (
        !matches ||
        actor.invalidationPending ||
        !this.isActorSubscribed(id)
      ) {
        continue;
      }
      actor.invalidationPending = true;
      const credential = this.requireCredential(actor.dataKey);
      credential.dirtyDataKeyIds.add(id);
      if (credential.authBlocked) {
        continue;
      }
      if (actor.inFlight) {
        continue;
      }
      actor.invalidationPending = false;
      const catchUp: Promise<unknown> =
        actor.kind === "chat-event"
          ? this.ensureChatEventSync(actor, credential)
          : this.ensureChatThreadEventSync(actor, credential);
      detach(
        settle(catchUp, this.rootSignal),
        Reason.Daemon,
        `shared database realtime catch-up: ${id}`,
      );
    }
  }

  private broadcastRealtimeStatus(
    userId: string,
    status: SharedDatabaseConnectionStatus,
  ): void {
    for (const client of this.clients.values()) {
      if (client.identity?.userId === userId) {
        const credential = this.credentials.get(
          sharedDatabaseCredentialId(client.identity),
        );
        client.emit({
          type: "status",
          status: credential?.authBlocked ? "disconnected" : status,
        });
      }
    }
  }

  private realtimeStatusForUser(
    userId: string,
  ): SharedDatabaseConnectionStatus {
    if (!this.hasRealtimeSubscriptions(userId)) {
      return "connected";
    }
    return this.realtimeStatuses.get(userId) ?? "connecting";
  }

  private restartRealtimeForUser(userId: string): void {
    this.realtimeSessions.get(userId)?.close();
    this.realtimeSessions.delete(userId);
    this.realtimeStatuses.delete(userId);
    if (this.hasRealtimeSubscriptions(userId)) {
      this.ensureRealtimeForUser(userId);
    }
  }

  private isActorSubscribed(actorId: string): boolean {
    return Array.from(this.clients.values()).some((client) => {
      return Array.from(client.subscriptions.values()).some((dataKey) => {
        return sharedDatabaseDataKeyId(dataKey) === actorId;
      });
    });
  }

  private hasRealtimeSubscriptions(userId: string): boolean {
    return Array.from(this.clients.values()).some((client) => {
      return Array.from(client.subscriptions.values()).some((dataKey) => {
        return dataKey.userId === userId;
      });
    });
  }

  private closeUnusedRealtimeSessions(): void {
    for (const [userId, session] of this.realtimeSessions) {
      if (!this.hasRealtimeSubscriptions(userId)) {
        session.close();
        this.realtimeSessions.delete(userId);
        this.realtimeStatuses.delete(userId);
        this.broadcastRealtimeStatus(userId, "connected");
      }
    }
  }

  private pruneStaleClients(): void {
    const staleBefore = now() - STALE_CLIENT_AFTER_MS;
    const staleClientIds = Array.from(this.clients.values()).flatMap(
      (client) => {
        return client.lastHeartbeatAt < staleBefore ? [client.clientId] : [];
      },
    );
    for (const clientId of staleClientIds) {
      this.disconnectClient(clientId);
    }
  }

  private removeUnusedActors(): void {
    const subscribedIds = new Set<string>();
    for (const client of this.clients.values()) {
      for (const dataKey of client.subscriptions.values()) {
        subscribedIds.add(sharedDatabaseDataKeyId(dataKey));
      }
    }
    for (const [id, actor] of this.actors) {
      if (!subscribedIds.has(id) && actor.inFlight === null) {
        this.actors.delete(id);
        this.credentials
          .get(sharedDatabaseCredentialId(actor.dataKey))
          ?.dirtyDataKeyIds.delete(id);
      }
    }
  }

  private releaseCredentialIfUnused(credentialId: string): void {
    const stillUsed = Array.from(this.clients.values()).some((client) => {
      return (
        client.identity !== null &&
        sharedDatabaseCredentialId(client.identity) === credentialId
      );
    });
    if (stillUsed) {
      return;
    }
    this.credentials.delete(credentialId);
    const database = this.databases.get(credentialId);
    database?.database?.close();
    this.databases.delete(credentialId);
  }
}
