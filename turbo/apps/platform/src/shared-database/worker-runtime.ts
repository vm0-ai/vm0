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
import { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import type { InboundMessage, TokenRequest } from "ably";
import type { IDBPDatabase } from "idb";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import {
  captureSentryLogError,
  sentryLogContext,
} from "../lib/sentry-config.ts";
import { now } from "../lib/time.ts";
import { logger } from "../signals/log.ts";
import { createChatIdbOpener } from "../signals/external/chat-idb-opener.ts";
import { createIdbEventRowStores } from "../signals/external/idb-event-row-store.ts";
import { createStrictIdbChatThreadEventStores } from "../signals/external/idb-chat-thread-event-store.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  detach,
  isAbortError,
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
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseConnectionStatus,
  type SharedDatabaseHeartbeatResult,
  type SharedDatabaseWorkerMessage,
} from "./protocol.ts";
import { createSharedDatabaseContractClient } from "./worker-client.ts";
import {
  createSharedDatabaseRealtimeSession,
  type SharedDatabaseRealtimeSession,
} from "./worker-realtime.ts";
import {
  assertChatEventSchemaVersion,
  CHAT_EVENT_SCHEMA_VERSION_HEADERS,
} from "./chat-event-schema-version.ts";
import { CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD } from "./event-log-policy.ts";

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const STALE_CLIENT_AFTER_MS = 3 * 60 * 1000;
const REALTIME_CATCH_UP_RETRY_DELAYS_MS = [1000, 2000, 5000] as const;
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
        sinceProjection: cursor.projection,
        limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
      };
}

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
  vercelProtectionBypass: string | undefined;
  authBlocked: boolean;
  rejectedToken: string | null;
  readonly dirtyDataKeyIds: Set<string>;
}

interface ChatEventSyncResult {
  readonly remoteRows: readonly ChatEventRow[];
  readonly changed: boolean;
}

type ChatEventContractClient = ReturnType<
  typeof createSharedDatabaseContractClient<typeof chatThreadEventsContract>
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
  readonly actor: ChatEventActor;
  readonly credential: CredentialState;
  readonly requestToken: string;
}

interface ChatThreadEventSyncResult {
  readonly result: ChatThreadEventQueryResult;
  readonly changed: boolean;
}

interface ChatThreadEventRemoteState {
  readonly result: ChatThreadEventQueryResult;
  readonly cursor: { readonly eventId: string; readonly seqId: number } | null;
  readonly replacement: boolean;
  readonly cursorFromServerSnapshot: boolean;
  readonly newEvents: readonly ChatThreadEvent[];
}

interface ChatThreadEventRemoteContext {
  readonly client: ReturnType<
    typeof createSharedDatabaseContractClient<typeof chatThreadsContract>
  >;
  readonly credential: CredentialState;
  readonly requestToken: string;
}

interface ChatEventActor {
  readonly kind: "chat-event";
  readonly dataKey: ChatEventDataKey;
  backgroundCatchUp: boolean;
  degraded: boolean;
  observedSeqId: number | null;
  invalidationPending: boolean;
  inFlight: Promise<ChatEventSyncResult> | null;
}

interface ChatThreadEventActor {
  readonly kind: "chat-thread-event";
  readonly dataKey: ChatThreadEventDataKey;
  degraded: boolean;
  observedSeqId: number | null;
  invalidationPending: boolean;
  initialSnapshotRebasePending: boolean;
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
  constructor(readonly status: number) {
    super(`Shared database request failed with status ${status}`);
    this.name = "SharedDatabaseHttpError";
  }
}

class SharedDatabaseClientNotConnectedError extends Error {
  constructor() {
    super("Shared database client is not connected");
    this.name = SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME;
  }
}

function actorDiagnosticDetails(actor: DatasetActor): {
  readonly dataset: DatasetActor["kind"];
  readonly orgId: string;
  readonly userId: string;
} {
  return {
    dataset: actor.kind,
    orgId: actor.dataKey.orgId,
    userId: actor.dataKey.userId,
  };
}

function reportActorError(
  actor: DatasetActor,
  operation: string,
  error: unknown,
): void {
  if (isAbortError(error) || error instanceof SharedDatabaseAuthBlockedError) {
    L.debug(operation, { ...actorDiagnosticDetails(actor), error });
    return;
  }
  const details = actorDiagnosticDetails(actor);
  const context = sentryLogContext({
    contexts: {
      shared_database: { org_id: actor.dataKey.orgId },
      ...(error instanceof SharedDatabaseHttpError
        ? { response: { status_code: error.status } }
        : {}),
    },
    tags: {
      "shared_database.dataset": actor.kind,
      "shared_database.operation": operation,
    },
    user: { id: actor.dataKey.userId },
  });
  L.debug(operation, { ...details, error });
  captureSentryLogError("SharedDatabaseWorker", [
    operation,
    error,
    details,
    context,
  ]);
}

function markActorDegraded(
  actor: DatasetActor,
  operation: string,
  error: unknown,
): void {
  if (actor.degraded) {
    return;
  }
  actor.degraded = true;
  reportActorError(actor, operation, error);
}

function markActorPersistenceRecovered(
  actor: DatasetActor,
  operation: string,
): void {
  if (actor.degraded) {
    L.debug(operation, actorDiagnosticDetails(actor));
  }
  actor.degraded = false;
}

function advanceObservedSeqId(
  actor: DatasetActor,
  seqId: number | null,
): boolean {
  if (seqId === null) {
    return false;
  }
  const previous = actor.observedSeqId;
  actor.observedSeqId = Math.max(previous ?? seqId, seqId);
  return seqId > (previous ?? THREAD_START_SEQ_ID);
}

function initializeObservedSeqId(
  actor: DatasetActor,
  seqId: number | null,
): void {
  if (actor.observedSeqId === null && seqId !== null) {
    actor.observedSeqId = seqId;
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

async function persistChatEventRows(
  input: {
    readonly stores: ReturnType<typeof createIdbEventRowStores>;
    readonly actor: ChatEventActor;
    readonly remoteRows: readonly ChatEventRow[];
    readonly cursor: ChatEventCursor;
    readonly replacedCache: boolean;
  },
  signal: AbortSignal,
): Promise<void> {
  const { stores, actor, remoteRows, cursor, replacedCache } = input;
  if (!replacedCache && remoteRows.length === 0) {
    return;
  }
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
  if (written.ok) {
    markActorPersistenceRecovered(
      actor,
      "indexeddb.chat-event.write.recovered",
    );
  } else {
    markActorDegraded(actor, "indexeddb.chat-event.write.error", written.error);
  }
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
        L.debug("runtime.abort");
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
    this.registerClient(clientId, emit);
  }

  private registerClient(
    clientId: string,
    emit: WorkerClientEmitter,
  ): WorkerClientRegistration {
    const client: WorkerClientRegistration = {
      clientId,
      emit,
      subscriptions: new Map(),
      identity: null,
      apiBaseUrl: null,
      lastHeartbeatAt: now(),
    };
    this.clients.set(clientId, client);
    L.debug("client.register", { clientId });
    emit({ type: "status", status: "connecting" });
    return client;
  }

  async heartbeat(
    clientId: string,
    emit: WorkerClientEmitter | undefined,
    identity: SharedDatabaseIdentity,
    apiBaseUrl: string,
    vercelProtectionBypass: string | undefined,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.rootSignal.throwIfAborted();
    const heartbeatAt = now();
    let client = this.clients.get(clientId);
    if (
      client &&
      client.lastHeartbeatAt < heartbeatAt - STALE_CLIENT_AFTER_MS
    ) {
      this.expireClient(clientId);
      client = undefined;
    }
    const clientReconnected = client === undefined;
    if (!client) {
      if (!emit) {
        throw new SharedDatabaseClientNotConnectedError();
      }
      client = this.registerClient(clientId, emit);
    }
    client.lastHeartbeatAt = heartbeatAt;
    this.pruneStaleClients(heartbeatAt);
    const previousCredentialId = client.identity
      ? sharedDatabaseCredentialId(client.identity)
      : null;
    const nextCredentialId = sharedDatabaseCredentialId(identity);
    const credentialChanged =
      previousCredentialId !== null &&
      previousCredentialId !== nextCredentialId;
    if (credentialChanged) {
      client.subscriptions.clear();
    }
    client.identity = identity;
    client.apiBaseUrl = apiBaseUrl;
    if (credentialChanged) {
      this.removeUnusedActors();
      this.closeUnusedRealtimeSessions();
      this.releaseCredentialIfUnused(previousCredentialId);
    }

    let credential = this.credentials.get(nextCredentialId);
    if (!credential) {
      credential = {
        userId: identity.userId,
        orgId: identity.orgId,
        token: identity.token,
        apiBaseUrl,
        vercelProtectionBypass,
        authBlocked: false,
        rejectedToken: null,
        dirtyDataKeyIds: new Set(),
      };
      this.credentials.set(nextCredentialId, credential);
    }

    const resumesAuthentication =
      credential.authBlocked && identity.token !== credential.rejectedToken;
    credential.apiBaseUrl = apiBaseUrl;
    credential.vercelProtectionBypass = vercelProtectionBypass;
    if (!credential.authBlocked || resumesAuthentication) {
      credential.token = identity.token;
    }
    if (resumesAuthentication) {
      L.debug("auth.resume", {
        clientId,
        orgId: identity.orgId,
        userId: identity.userId,
      });
      credential.authBlocked = false;
      credential.rejectedToken = null;
      client.emit({ type: "status", status: "connecting" });
      this.restartRealtimeForCredential(credential);
      await this.catchUpDirtyActors(credential);
    }
    this.ensureRealtimeForCredential(credential);
    client.emit({
      type: "status",
      status: credential.authBlocked
        ? "disconnected"
        : this.realtimeStatusForCredential(nextCredentialId),
    });
    L.debug("client.heartbeat", {
      authBlocked: credential.authBlocked,
      clientId,
      clientReconnected,
      orgId: identity.orgId,
      userId: identity.userId,
    });
    return { clientReconnected };
  }

  disconnectClient(clientId: string): void {
    this.expireClient(clientId);
  }

  private expireClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    const credentialId = client.identity
      ? sharedDatabaseCredentialId(client.identity)
      : null;
    L.debug("client.unregister", { clientId });
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
    const actorId = sharedDatabaseDataKeyId(dataKey);
    const alreadySubscribed = this.isActorSubscribed(actorId);
    L.debug("subscription.add", {
      clientId,
      dataset: dataKey.kind,
      subscriptionId,
    });
    client.subscriptions.set(subscriptionId, dataKey);
    const actor = this.getOrCreateActor(dataKey);
    const credential = this.requireCredential(dataKey);
    if (
      !alreadySubscribed &&
      this.realtimeStatuses.get(sharedDatabaseCredentialId(credential)) ===
        "connected"
    ) {
      this.enqueueActorCatchUp(
        actor,
        credential,
        `shared database subscribed actor catch-up: ${actorId}`,
      );
    }
  }

  unsubscribe(clientId: string, subscriptionId: string): void {
    const client = this.clients.get(clientId);
    L.debug("subscription.remove", { clientId, subscriptionId });
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
    const startedAt = now();
    L.debug("sync.start", actorDiagnosticDetails(actor));
    const [settled] = await Promise.allSettled([
      this.runActiveSyncWithRetries(actor, credential, () => {
        return this.syncChatEvents(actor, credential, this.rootSignal);
      }),
    ]);
    actor.inFlight = null;
    const repeatAfterCurrentSync = actor.invalidationPending;
    actor.invalidationPending = false;
    if (settled?.status === "fulfilled") {
      if (!repeatAfterCurrentSync) {
        actor.backgroundCatchUp = false;
      }
      credential.dirtyDataKeyIds.delete(sharedDatabaseDataKeyId(actor.dataKey));
      if (settled.value.changed) {
        this.notifyActor(actor.dataKey);
      }
      this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
      this.cleanupActorAfterSync(actor);
      L.debug("sync.finish", {
        ...actorDiagnosticDetails(actor),
        changed: settled.value.changed,
        durationMs: now() - startedAt,
      });
      return settled.value;
    }
    if (!repeatAfterCurrentSync && !credential.authBlocked) {
      actor.backgroundCatchUp = false;
    }
    credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
    this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
    this.cleanupActorAfterSync(actor);
    reportActorError(actor, "sync.error", settled?.reason);
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
    const startedAt = now();
    L.debug("sync.start", actorDiagnosticDetails(actor));
    const [settled] = await Promise.allSettled([
      this.runActiveSyncWithRetries(actor, credential, () => {
        return this.syncChatThreadEvents(actor, credential, this.rootSignal);
      }),
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
      this.cleanupActorAfterSync(actor);
      L.debug("sync.finish", {
        ...actorDiagnosticDetails(actor),
        changed: settled.value.changed,
        durationMs: now() - startedAt,
      });
      return settled.value;
    }
    credential.dirtyDataKeyIds.add(sharedDatabaseDataKeyId(actor.dataKey));
    this.repeatRealtimeCatchUp(actor, credential, repeatAfterCurrentSync);
    this.cleanupActorAfterSync(actor);
    reportActorError(actor, "sync.error", settled?.reason);
    throw settled?.reason;
  }

  private async runActiveSyncWithRetries<T>(
    actor: DatasetActor,
    credential: CredentialState,
    run: () => Promise<T>,
    retryIndex = 0,
  ): Promise<T> {
    const result = await settle(run(), this.rootSignal);
    if (result.ok) {
      return result.value;
    }
    const actorId = sharedDatabaseDataKeyId(actor.dataKey);
    credential.dirtyDataKeyIds.add(actorId);
    const retryDelayMs = REALTIME_CATCH_UP_RETRY_DELAYS_MS[retryIndex];
    if (
      retryDelayMs === undefined ||
      credential.authBlocked ||
      !this.isActorActive(actorId)
    ) {
      throw result.error;
    }
    L.debug("sync.retry", {
      ...actorDiagnosticDetails(actor),
      error: result.error,
      retry: retryIndex + 1,
      retryInMs: retryDelayMs,
    });
    await delay(IN_VITEST ? 0 : retryDelayMs, { signal: this.rootSignal });
    this.rootSignal.throwIfAborted();
    if (credential.authBlocked || !this.isActorActive(actorId)) {
      throw result.error;
    }
    return await this.runActiveSyncWithRetries(
      actor,
      credential,
      run,
      retryIndex + 1,
    );
  }

  private repeatRealtimeCatchUp(
    actor: DatasetActor,
    credential: CredentialState,
    repeat: boolean,
  ): void {
    const actorId = sharedDatabaseDataKeyId(actor.dataKey);
    if (!repeat || credential.authBlocked || !this.isActorActive(actorId)) {
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
    initializeObservedSeqId(actor, cachedCursor?.lastSeqId ?? null);
    if (!cachedCursorResult.ok) {
      markActorDegraded(
        actor,
        "indexeddb.chat-event-cursor.read.error",
        cachedCursorResult.error,
      );
    }

    const requestToken = credential.token;
    const client = createSharedDatabaseContractClient(
      chatThreadEventsContract,
      credential.apiBaseUrl,
      () => {
        return requestToken;
      },
      () => {
        return credential.vercelProtectionBypass;
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

    if (cachedCursor === null || actor.degraded) {
      const snapshot = await this.fetchChatEventSnapshot(
        client,
        actor.dataKey,
        credential,
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
      { client, actor, credential, requestToken },
      state,
      signal,
    );
    await persistChatEventRows(
      {
        stores,
        actor,
        remoteRows: state.remoteRows,
        cursor: state.cursor,
        replacedCache: state.replacedCache,
      },
      signal,
    );
    const changed = advanceObservedSeqId(actor, state.cursor.lastSeqId);
    return {
      remoteRows: state.remoteRows,
      changed,
    };
  }

  private async fetchChatEventRows(
    context: ChatEventRemoteContext,
    initialState: ChatEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatEventRemoteState> {
    const { client, actor, credential, requestToken } = context;
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
        params: { threadId: actor.dataKey.threadId },
        query: chatEventRowsQuery(cursor),
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(credential, requestToken);
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
    dataKey: ChatEventDataKey,
    credential: CredentialState,
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
      this.blockCredential(credential, requestToken);
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
              projection: snapshot.body.projection,
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
      () => {
        return credential.vercelProtectionBypass;
      },
    );
    const cachedCursor = chatThreadEventCursor(cached);
    initializeObservedSeqId(actor, cachedCursor?.seqId ?? null);
    let state: ChatThreadEventRemoteState = {
      result: cached,
      cursor: cachedCursor,
      replacement: false,
      cursorFromServerSnapshot: false,
      newEvents: [],
    };

    if (cached.snapshot === null || cachedCursor === null || actor.degraded) {
      const result = {
        snapshot: await this.fetchChatThreadSnapshot(
          client,
          credential,
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

    const remoteContext = { client, credential, requestToken };
    state = await this.loadChatThreadEventTail(remoteContext, state, signal);
    state = await this.maybeRebaseChatThreadEventSnapshot(
      actor,
      remoteContext,
      state,
      signal,
    );

    const shouldWrite = state.replacement || state.newEvents.length > 0;
    if (shouldWrite) {
      const stores = createStrictIdbChatThreadEventStores(() => {
        return this.getDatabase(actor.dataKey);
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
      if (written.ok) {
        markActorPersistenceRecovered(
          actor,
          "indexeddb.chat-thread-event.write.recovered",
        );
      } else {
        markActorDegraded(
          actor,
          "indexeddb.chat-thread-event.write.error",
          written.error,
        );
      }
    }
    return {
      result: state.result,
      changed: advanceObservedSeqId(actor, state.cursor?.seqId ?? null),
    };
  }

  private async loadChatThreadEventTail(
    context: ChatThreadEventRemoteContext,
    initialState: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    const { client, credential, requestToken } = context;
    let state = initialState;
    let hasMore = true;
    while (hasMore) {
      const page = await client.events({
        query: state.cursor ? { sinceSeqId: state.cursor.seqId } : {},
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401) {
        this.blockCredential(credential, requestToken);
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
            credential,
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
    actor: ChatThreadEventActor,
    context: ChatThreadEventRemoteContext,
    state: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    const { client, credential, requestToken } = context;
    if (!actor.initialSnapshotRebasePending) {
      return state;
    }
    actor.initialSnapshotRebasePending = false;
    if (
      state.replacement ||
      state.result.events.length <=
        CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD
    ) {
      return state;
    }
    const rebasedSnapshot = await settle(
      this.fetchChatThreadSnapshot(client, credential, requestToken, signal),
      signal,
    );
    if (!rebasedSnapshot.ok) {
      if (credential.authBlocked) {
        throw rebasedSnapshot.error;
      }
      L.debug("snapshot-rebase.skip", {
        ...actorDiagnosticDetails(actor),
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
      markActorDegraded(actor, "indexeddb.chat-event.read.error", result.error);
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
      markActorDegraded(
        actor,
        "indexeddb.chat-thread-event.read.error",
        result.error,
      );
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

  private getOrCreateActor(dataKey: ChatEventDataKey): ChatEventActor;
  private getOrCreateActor(
    dataKey: ChatThreadEventDataKey,
  ): ChatThreadEventActor;
  private getOrCreateActor(dataKey: SharedDatabaseDataKey): DatasetActor;
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
            backgroundCatchUp: false,
            degraded: false,
            observedSeqId: null,
            invalidationPending: false,
            inFlight: null,
          }
        : {
            kind: "chat-thread-event",
            dataKey,
            degraded: false,
            observedSeqId: null,
            invalidationPending: false,
            initialSnapshotRebasePending: true,
            inFlight: null,
          };
    this.actors.set(id, actor);
    return actor;
  }

  private requireClient(clientId: string): WorkerClientRegistration {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new SharedDatabaseClientNotConnectedError();
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
    L.debug("auth.block", {
      orgId: credential.orgId,
      userId: credential.userId,
    });
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

  private ensureRealtimeForCredential(credential: CredentialState): void {
    const credentialId = sharedDatabaseCredentialId(credential);
    if (this.realtimeSessions.has(credentialId) || credential.authBlocked) {
      return;
    }
    this.realtimeStatuses.set(credentialId, "connecting");
    this.broadcastRealtimeStatus(credential, "connecting");
    const session = createSharedDatabaseRealtimeSession(
      {
        userId: credential.userId,
        orgId: credential.orgId,
        getTokenRequest: async () => {
          return await this.fetchRealtimeTokenRequest(credential);
        },
        onMessage: (message) => {
          this.handleRealtimeMessage(credential, message);
        },
        onStatus: (status) => {
          this.realtimeStatuses.set(credentialId, status);
          this.broadcastRealtimeStatus(credential, status);
        },
      },
      this.rootSignal,
    );
    this.realtimeSessions.set(credentialId, session);
    const catchUpAfterAttach = (async (): Promise<void> => {
      const attached = await session.ready;
      this.rootSignal.throwIfAborted();
      if (this.realtimeSessions.get(credentialId) !== session) {
        return;
      }
      if (!attached) {
        session.close();
        this.realtimeSessions.delete(credentialId);
        this.realtimeStatuses.set(credentialId, "disconnected");
        this.broadcastRealtimeStatus(credential, "disconnected");
        return;
      }
      this.catchUpSubscribedActorsForCredential(credential);
    })();
    detach(
      settle(catchUpAfterAttach, this.rootSignal),
      Reason.Daemon,
      `shared database post-attach catch-up: ${credentialId}`,
    );
  }

  private async fetchRealtimeTokenRequest(
    credential: CredentialState,
  ): Promise<TokenRequest> {
    if (credential.authBlocked) {
      throw new SharedDatabaseAuthBlockedError();
    }
    const requestToken = credential.token;
    const client = createSharedDatabaseContractClient(
      platformRealtimeTokenContract,
      credential.apiBaseUrl,
      () => {
        return requestToken;
      },
      () => {
        return credential.vercelProtectionBypass;
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

  private handleRealtimeMessage(
    credential: CredentialState,
    message: InboundMessage,
  ): void {
    const topic = message.name ?? "";
    const threadId = topic.startsWith("chatThreadMessageCreated:")
      ? topic.slice("chatThreadMessageCreated:".length)
      : null;
    if (threadId !== null && threadId.length > 0) {
      const dataKey: ChatEventDataKey = {
        kind: "chat-event",
        userId: credential.userId,
        orgId: credential.orgId,
        threadId,
      };
      const actor = this.getOrCreateActor(dataKey);
      actor.backgroundCatchUp = true;
      this.enqueueActorCatchUp(
        actor,
        credential,
        `shared database background realtime catch-up: ${sharedDatabaseDataKeyId(dataKey)}`,
      );
      return;
    }
    if (topic !== "threadListChanged") {
      return;
    }
    for (const [id, actor] of this.actors) {
      const matches =
        actor.kind === "chat-thread-event" &&
        actor.dataKey.userId === credential.userId &&
        actor.dataKey.orgId === credential.orgId;
      if (!matches || !this.isActorSubscribed(id)) {
        continue;
      }
      this.enqueueActorCatchUp(
        actor,
        credential,
        `shared database realtime catch-up: ${id}`,
      );
    }
  }

  private catchUpSubscribedActorsForCredential(
    credential: CredentialState,
  ): void {
    for (const actor of this.actors.values()) {
      const actorId = sharedDatabaseDataKeyId(actor.dataKey);
      if (
        actor.dataKey.userId !== credential.userId ||
        actor.dataKey.orgId !== credential.orgId ||
        !this.isActorSubscribed(actorId)
      ) {
        continue;
      }
      this.enqueueActorCatchUp(
        actor,
        credential,
        `shared database post-attach actor catch-up: ${actorId}`,
      );
    }
  }

  private enqueueActorCatchUp(
    actor: DatasetActor,
    credential: CredentialState,
    description: string,
  ): void {
    const actorId = sharedDatabaseDataKeyId(actor.dataKey);
    if (actor.invalidationPending || !this.isActorActive(actorId)) {
      return;
    }
    actor.invalidationPending = true;
    credential.dirtyDataKeyIds.add(actorId);
    if (credential.authBlocked || actor.inFlight) {
      return;
    }
    actor.invalidationPending = false;
    const catchUp: Promise<unknown> =
      actor.kind === "chat-event"
        ? this.ensureChatEventSync(actor, credential)
        : this.ensureChatThreadEventSync(actor, credential);
    detach(settle(catchUp, this.rootSignal), Reason.Daemon, description);
  }

  private broadcastRealtimeStatus(
    credential: CredentialState,
    status: SharedDatabaseConnectionStatus,
  ): void {
    for (const client of this.clients.values()) {
      if (
        client.identity?.userId === credential.userId &&
        client.identity.orgId === credential.orgId
      ) {
        client.emit({
          type: "status",
          status: credential.authBlocked ? "disconnected" : status,
        });
      }
    }
  }

  private realtimeStatusForCredential(
    credentialId: string,
  ): SharedDatabaseConnectionStatus {
    return this.realtimeStatuses.get(credentialId) ?? "connecting";
  }

  private restartRealtimeForCredential(credential: CredentialState): void {
    const credentialId = sharedDatabaseCredentialId(credential);
    this.realtimeSessions.get(credentialId)?.close();
    this.realtimeSessions.delete(credentialId);
    this.realtimeStatuses.delete(credentialId);
    if (this.hasCredentialClient(credentialId)) {
      this.ensureRealtimeForCredential(credential);
    }
  }

  private isActorSubscribed(actorId: string): boolean {
    return Array.from(this.clients.values()).some((client) => {
      return Array.from(client.subscriptions.values()).some((dataKey) => {
        return sharedDatabaseDataKeyId(dataKey) === actorId;
      });
    });
  }

  private isActorActive(actorId: string): boolean {
    const actor = this.actors.get(actorId);
    return (
      this.isActorSubscribed(actorId) ||
      (actor?.kind === "chat-event" && actor.backgroundCatchUp)
    );
  }

  private hasCredentialClient(credentialId: string): boolean {
    return Array.from(this.clients.values()).some((client) => {
      return (
        client.identity !== null &&
        sharedDatabaseCredentialId(client.identity) === credentialId
      );
    });
  }

  private closeUnusedRealtimeSessions(): void {
    for (const [credentialId, session] of this.realtimeSessions) {
      if (!this.hasCredentialClient(credentialId)) {
        const credential = this.credentials.get(credentialId);
        session.close();
        this.realtimeSessions.delete(credentialId);
        this.realtimeStatuses.delete(credentialId);
        if (credential) {
          this.broadcastRealtimeStatus(credential, "connected");
        }
      }
    }
  }

  private pruneStaleClients(currentTime: number): void {
    const staleBefore = currentTime - STALE_CLIENT_AFTER_MS;
    const staleClientIds = Array.from(this.clients.values()).flatMap(
      (client) => {
        return client.lastHeartbeatAt < staleBefore ? [client.clientId] : [];
      },
    );
    for (const clientId of staleClientIds) {
      this.expireClient(clientId);
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
      if (
        !subscribedIds.has(id) &&
        actor.inFlight === null &&
        !this.isActorActive(id)
      ) {
        this.actors.delete(id);
        this.credentials
          .get(sharedDatabaseCredentialId(actor.dataKey))
          ?.dirtyDataKeyIds.delete(id);
      }
    }
  }

  private cleanupActorAfterSync(actor: DatasetActor): void {
    this.removeUnusedActors();
    this.releaseCredentialIfUnused(sharedDatabaseCredentialId(actor.dataKey));
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
    this.realtimeSessions.get(credentialId)?.close();
    this.realtimeSessions.delete(credentialId);
    this.realtimeStatuses.delete(credentialId);

    for (const actor of this.actors.values()) {
      if (sharedDatabaseCredentialId(actor.dataKey) !== credentialId) {
        continue;
      }
      actor.invalidationPending = false;
      if (actor.kind === "chat-event") {
        actor.backgroundCatchUp = false;
      }
    }
    this.removeUnusedActors();
    const syncStillInFlight = Array.from(this.actors.values()).some((actor) => {
      return (
        sharedDatabaseCredentialId(actor.dataKey) === credentialId &&
        actor.inFlight !== null
      );
    });
    if (syncStillInFlight) {
      return;
    }

    this.credentials.delete(credentialId);
    const database = this.databases.get(credentialId);
    database?.database?.close();
    this.databases.delete(credentialId);
  }
}
