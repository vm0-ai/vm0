import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  replayChatThreadEvents,
  type EventDrivenChatThread,
} from "@vm0/core/chat-thread-event-replay";

import {
  getZeroChatThreadSnapshot,
  listZeroChatThreadEvents,
  type ZeroChatThreadEvent,
  type ZeroChatThreadSnapshot,
} from "../../../lib/api";
import { decodeZeroTokenPayload, getApiUrl } from "../../../lib/api/config";

const CACHE_VERSION = 2;
const MAX_EVENT_PAGES_PER_SYNC = 20;

interface ChatThreadCache {
  readonly version: typeof CACHE_VERSION;
  readonly snapshot: ZeroChatThreadSnapshot;
  readonly events: readonly ZeroChatThreadEvent[];
}

interface ChatThreadEventCursor {
  readonly eventId: string;
  readonly seqId?: number;
}

const cachedChatThreadEventSchema = chatThreadEventSchema.extend({
  seqId: chatThreadEventSchema.shape.seqId.optional(),
});

function eventHasSeqId(
  event: ZeroChatThreadEvent,
): event is ZeroChatThreadEvent & { readonly seqId: number } {
  return event.seqId !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCache(raw: string): ChatThreadCache | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }

  if (
    !isRecord(value) ||
    value.version !== CACHE_VERSION ||
    !isRecord(value.snapshot)
  ) {
    return null;
  }

  const chatThreads = chatThreadSnapshotProjectionSchema
    .array()
    .safeParse(value.snapshot.chatThreads);
  const events = cachedChatThreadEventSchema.array().safeParse(value.events);
  const latestEventId = value.snapshot.latestEventId;
  const latestSeqId = value.snapshot.latestSeqId;
  if (
    !chatThreads.success ||
    !events.success ||
    (latestEventId !== null && typeof latestEventId !== "string") ||
    (latestSeqId !== null &&
      (typeof latestSeqId !== "number" ||
        !Number.isSafeInteger(latestSeqId) ||
        latestSeqId <= 0))
  ) {
    return null;
  }

  return {
    version: CACHE_VERSION,
    snapshot: {
      chatThreads: chatThreads.data,
      latestEventId,
      latestSeqId,
    },
    events: events.data,
  };
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

async function cachePath(): Promise<string> {
  const token = decodeZeroTokenPayload();
  if (!token) {
    throw new Error("ZERO_TOKEN does not contain a valid Zero cache scope");
  }
  const apiUrl = await getApiUrl();
  const scope = createHash("sha256")
    .update(`${apiUrl}\0${token.orgId}\0${token.userId}`)
    .digest("hex");
  return join(cacheRoot(), "vm0", "zero", "chat-threads", `${scope}.json`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readCache(path: string): Promise<ChatThreadCache | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return parseCache(raw);
}

async function writeCache(path: string, cache: ChatThreadCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function mergeEvents(
  existing: readonly ZeroChatThreadEvent[],
  incoming: readonly ZeroChatThreadEvent[],
): ZeroChatThreadEvent[] {
  const byId = new Map<string, ZeroChatThreadEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  const merged = [...byId.values()];
  return merged.every(eventHasSeqId)
    ? merged.sort((left, right) => {
        return left.seqId - right.seqId;
      })
    : merged;
}

async function freshCache(): Promise<ChatThreadCache> {
  return {
    version: CACHE_VERSION,
    snapshot: await getZeroChatThreadSnapshot(),
    events: [],
  };
}

function latestEventCursor(
  cache: ChatThreadCache,
): ChatThreadEventCursor | undefined {
  const event = cache.events.at(-1);
  if (event) {
    return {
      eventId: event.id,
      ...(event.seqId !== undefined ? { seqId: event.seqId } : {}),
    };
  }
  if (cache.snapshot.latestEventId === null) {
    return undefined;
  }
  return {
    eventId: cache.snapshot.latestEventId,
    ...(cache.snapshot.latestSeqId !== null
      ? { seqId: cache.snapshot.latestSeqId }
      : {}),
  };
}

export async function syncCachedChatThreads(): Promise<
  EventDrivenChatThread[]
> {
  const path = await cachePath();
  let cache = (await readCache(path)) ?? (await freshCache());
  let cursor = latestEventCursor(cache);

  for (let page = 0; page < MAX_EVENT_PAGES_PER_SYNC; page++) {
    const result = await listZeroChatThreadEvents({
      sinceSeqId: cursor?.seqId,
      sinceEventId: cursor?.eventId,
    });
    if (result.kind === "expired") {
      cache = await freshCache();
      cursor = latestEventCursor(cache);
      continue;
    }

    if (result.events.length > 0) {
      cache = {
        ...cache,
        events: mergeEvents(cache.events, result.events),
      };
      const lastEvent = result.events.at(-1);
      if (lastEvent) {
        cursor = {
          eventId: lastEvent.id,
          ...(lastEvent.seqId !== undefined ? { seqId: lastEvent.seqId } : {}),
        };
      }
    }

    if (!result.hasMore || result.events.length === 0) {
      break;
    }
  }

  await writeCache(path, cache);
  return replayChatThreadEvents(cache.snapshot.chatThreads, cache.events);
}
