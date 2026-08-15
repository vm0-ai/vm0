import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";

import {
  getZeroChatEventSnapshot,
  listZeroChatEventRows,
} from "../../../lib/api/domains/zero-chat";

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const SNAPSHOT_FILE_PATTERN = /^snapshot-to-(\d+)\.ndjson$/;
const EVENT_FILE_PATTERN = /^event-SEQ_ID_(\d+)\.json$/;

interface ManagedHistoryFile {
  readonly name: string;
  readonly kind: "snapshot" | "event";
  readonly seqId: number;
}

interface RawChatHistorySyncResult {
  readonly directory: string;
  readonly files: readonly string[];
}

type LocalHistoryState =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly cursor: ChatEventCursor };

interface ParsedSnapshot {
  readonly lastEventId: string;
  readonly lastRowSeqId: number;
}

function managedHistoryFile(name: string): ManagedHistoryFile | null {
  const snapshot = SNAPSHOT_FILE_PATTERN.exec(name);
  if (snapshot) {
    return {
      name,
      kind: "snapshot",
      seqId: Number(snapshot[1]),
    };
  }
  const event = EVENT_FILE_PATTERN.exec(name);
  if (event) {
    return {
      name,
      kind: "event",
      seqId: Number(event[1]),
    };
  }
  return null;
}

async function listManagedHistoryFiles(
  directory: string,
): Promise<ManagedHistoryFile[]> {
  const names = await readdir(directory);
  return names
    .flatMap((name) => {
      const file = managedHistoryFile(name);
      return file ? [file] : [];
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "snapshot" ? -1 : 1;
      }
      return left.seqId - right.seqId;
    });
}

function parseSnapshot(args: {
  readonly text: string;
  readonly threadId: string;
}): ParsedSnapshot {
  if (args.text.length === 0 || !args.text.endsWith("\n")) {
    throw new Error("Chat event snapshot must be newline-delimited JSON");
  }
  let lastEventId: string | undefined;
  let lastRowSeqId: number | undefined;
  for (const line of args.text.slice(0, -1).split("\n")) {
    const row = chatEventRowSchema.parse(JSON.parse(line));
    if (row.chatThreadId !== args.threadId) {
      throw new Error("Chat event snapshot belongs to another thread");
    }
    if (lastRowSeqId !== undefined && row.seqId <= lastRowSeqId) {
      throw new Error(
        "Chat event snapshot rows must be ordered by sequence ID",
      );
    }
    lastEventId = row.id;
    lastRowSeqId = row.seqId;
  }
  if (lastEventId === undefined || lastRowSeqId === undefined) {
    throw new Error("Chat event snapshot must contain at least one row");
  }
  return { lastEventId, lastRowSeqId };
}

async function localHistoryState(args: {
  readonly directory: string;
  readonly threadId: string;
  readonly files: readonly ManagedHistoryFile[];
}): Promise<LocalHistoryState> {
  if (args.files.length === 0) {
    return { kind: "empty" };
  }

  const snapshots = args.files.filter((file) => {
    return file.kind === "snapshot";
  });
  if (snapshots.length > 1) {
    return { kind: "invalid" };
  }
  const events = args.files.filter((file) => {
    return file.kind === "event";
  });
  let cursor: ChatEventCursor = {
    lastEventId: null,
    lastSeqId: THREAD_START_SEQ_ID,
  };
  const snapshot = snapshots[0];
  if (snapshot !== undefined) {
    try {
      const text = await readFile(join(args.directory, snapshot.name), "utf8");
      const parsed = parseSnapshot({ text, threadId: args.threadId });
      if (parsed.lastRowSeqId > snapshot.seqId) {
        return { kind: "invalid" };
      }
      cursor = {
        lastEventId: parsed.lastEventId,
        lastSeqId: snapshot.seqId,
      };
    } catch {
      return { kind: "invalid" };
    }
  }
  let previousSeqId = cursor.lastSeqId;
  for (const event of events) {
    if (event.seqId <= previousSeqId) {
      return { kind: "invalid" };
    }
    try {
      const text = await readFile(join(args.directory, event.name), "utf8");
      if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
        return { kind: "invalid" };
      }
      const row = chatEventRowSchema.parse(JSON.parse(text.slice(0, -1)));
      if (row.chatThreadId !== args.threadId || row.seqId !== event.seqId) {
        return { kind: "invalid" };
      }
      cursor = { lastEventId: row.id, lastSeqId: row.seqId };
    } catch {
      return { kind: "invalid" };
    }
    previousSeqId = event.seqId;
  }
  return snapshot !== undefined || events.length > 0
    ? { kind: "valid", cursor }
    : { kind: "invalid" };
}

async function downloadSnapshot(args: {
  readonly url: string;
  readonly threadId: string;
  readonly expectedLastEventId: string;
}): Promise<string> {
  const response = await fetch(args.url);
  if (!response.ok) {
    throw new Error(
      `Chat event snapshot download failed with status ${response.status}`,
    );
  }
  const text = await response.text();
  const parsed = parseSnapshot({ text, threadId: args.threadId });
  if (args.expectedLastEventId !== parsed.lastEventId) {
    throw new Error("Chat event snapshot terminal event ID does not match");
  }
  return text;
}

async function syncRows(args: {
  readonly threadId: string;
  readonly directory: string;
  readonly cursor: ChatEventCursor;
}): Promise<"complete" | "expired"> {
  let cursor = args.cursor;
  for (;;) {
    const page = await listZeroChatEventRows(
      cursor.lastEventId === null
        ? {
            threadId: args.threadId,
            sinceEventId: null,
            sinceSeqId: 0,
            limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
          }
        : {
            threadId: args.threadId,
            sinceEventId: cursor.lastEventId,
            sinceSeqId: cursor.lastSeqId,
            limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
          },
    );
    if (page.kind === "expired") {
      return "expired";
    }
    let previousSeqId = cursor.lastSeqId;
    for (const row of page.rows) {
      if (row.seqId <= previousSeqId) {
        throw new Error(
          "Chat event rows must have strictly increasing sequence IDs",
        );
      }
      previousSeqId = row.seqId;
    }
    const stagedDirectory = await mkdtemp(
      join(args.directory, ".okou-chat-history-page-"),
    );
    try {
      await Promise.all(
        page.rows.map((row) => {
          return writeFile(
            join(stagedDirectory, `event-SEQ_ID_${row.seqId}.json`),
            `${JSON.stringify(row)}\n`,
            "utf8",
          );
        }),
      );
      for (const row of page.rows) {
        const name = `event-SEQ_ID_${row.seqId}.json`;
        await rename(join(stagedDirectory, name), join(args.directory, name));
      }
    } finally {
      await rm(stagedDirectory, { recursive: true, force: true });
    }
    const lastRow = page.rows.at(-1);
    if (lastRow !== undefined) {
      cursor = { lastEventId: lastRow.id, lastSeqId: lastRow.seqId };
    }
    if (page.rows.length < CHAT_EVENT_ROWS_PAGE_LIMIT) {
      return "complete";
    }
  }
}

async function replaceManagedHistoryFiles(args: {
  readonly targetDirectory: string;
  readonly stagedDirectory: string;
}): Promise<void> {
  const [existing, staged] = await Promise.all([
    listManagedHistoryFiles(args.targetDirectory),
    listManagedHistoryFiles(args.stagedDirectory),
  ]);
  // Removing the newest rows first and installing the new generation oldest
  // first preserves cursor-prefix ordering during replacement.
  for (const file of [...existing].reverse()) {
    await rm(join(args.targetDirectory, file.name));
  }
  for (const file of staged) {
    await rename(
      join(args.stagedDirectory, file.name),
      join(args.targetDirectory, file.name),
    );
  }
}

async function rebuildRawChatHistory(args: {
  readonly threadId: string;
  readonly outputDirectory: string;
  readonly threadDirectory: string;
}): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(args.outputDirectory, ".okou-chat-history-"),
  );
  try {
    const snapshot = await getZeroChatEventSnapshot({
      threadId: args.threadId,
    });
    let cursor: ChatEventCursor = {
      lastEventId: null,
      lastSeqId: THREAD_START_SEQ_ID,
    };
    if (snapshot) {
      const downloaded = await downloadSnapshot({
        url: snapshot.url,
        threadId: args.threadId,
        expectedLastEventId: snapshot.lastEventId,
      });
      await writeFile(
        join(temporaryDirectory, `snapshot-to-${snapshot.lastSeqId}.ndjson`),
        downloaded,
        "utf8",
      );
      cursor = {
        lastEventId: snapshot.lastEventId,
        lastSeqId: snapshot.lastSeqId,
      };
    }

    const result = await syncRows({
      threadId: args.threadId,
      directory: temporaryDirectory,
      cursor,
    });
    if (result === "expired") {
      throw new Error(
        "Chat event rows cursor expired immediately after snapshot download",
      );
    }
    await replaceManagedHistoryFiles({
      targetDirectory: args.threadDirectory,
      stagedDirectory: temporaryDirectory,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function syncRawChatHistory(args: {
  readonly threadId: string;
  readonly outputDirectory: string;
}): Promise<RawChatHistorySyncResult> {
  await mkdir(args.outputDirectory, { recursive: true });
  const threadDirectory = join(args.outputDirectory, args.threadId);
  await mkdir(threadDirectory, { recursive: true });
  const existing = await listManagedHistoryFiles(threadDirectory);
  const state = await localHistoryState({
    directory: threadDirectory,
    threadId: args.threadId,
    files: existing,
  });

  if (state.kind !== "valid") {
    await rebuildRawChatHistory({
      threadId: args.threadId,
      outputDirectory: args.outputDirectory,
      threadDirectory,
    });
  } else {
    const result = await syncRows({
      threadId: args.threadId,
      directory: threadDirectory,
      cursor: state.cursor,
    });
    if (result === "expired") {
      await rebuildRawChatHistory({
        threadId: args.threadId,
        outputDirectory: args.outputDirectory,
        threadDirectory,
      });
    }
  }

  const files = (await listManagedHistoryFiles(threadDirectory)).map((file) => {
    return join(threadDirectory, file.name);
  });
  return { directory: threadDirectory, files };
}
