import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
  type ChatThreadEvent,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  replayChatThreadEvents,
  type EventDrivenChatThread,
} from "@vm0/core/chat-thread-event-replay";

import {
  getZeroChatThreadSnapshot,
  listZeroChatThreadEvents,
  type ZeroChatThreadSnapshot,
} from "../../../lib/api";
import { decodeZeroTokenPayload, getApiUrl } from "../../../lib/api/config";

const CACHE_VERSION = 2;
const MAX_EVENT_PAGES_PER_SYNC = 20;

interface ChatThreadCache {
  readonly version: typeof CACHE_VERSION;
  readonly snapshot: ZeroChatThreadSnapshot;
  readonly events: readonly ChatThreadEvent[];
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
  const events = chatThreadEventSchema.array().safeParse(value.events);
  const latestSeqId = value.snapshot.latestSeqId;
  if (
    !chatThreads.success ||
    !events.success ||
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
  existing: readonly ChatThreadEvent[],
  incoming: readonly ChatThreadEvent[],
): ChatThreadEvent[] {
  const byId = new Map<string, ChatThreadEvent>();
  for (const event of existing) {
    byId.set(event.id, event);
  }
  for (const event of incoming) {
    byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

async function freshCache(): Promise<ChatThreadCache> {
  return {
    version: CACHE_VERSION,
    snapshot: await getZeroChatThreadSnapshot(),
    events: [],
  };
}

function latestSeqId(cache: ChatThreadCache): number | undefined {
  return cache.events.at(-1)?.seqId ?? cache.snapshot.latestSeqId ?? undefined;
}

export async function syncCachedChatThreads(): Promise<
  EventDrivenChatThread[]
> {
  const path = await cachePath();
  let cache = (await readCache(path)) ?? (await freshCache());
  let cursor = latestSeqId(cache);

  for (let page = 0; page < MAX_EVENT_PAGES_PER_SYNC; page++) {
    const result = await listZeroChatThreadEvents({
      sinceSeqId: cursor,
    });
    if (result.kind === "expired") {
      cache = await freshCache();
      cursor = latestSeqId(cache);
      continue;
    }

    if (result.events.length > 0) {
      cache = {
        ...cache,
        events: mergeEvents(cache.events, result.events),
      };
      const lastEvent = result.events.at(-1);
      if (lastEvent) {
        cursor = lastEvent.seqId;
      }
    }

    if (!result.hasMore || result.events.length === 0) {
      break;
    }
  }

  await writeCache(path, cache);
  return replayChatThreadEvents(cache.snapshot.chatThreads, cache.events);
}
