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

import { chatEventRowV4Schema } from "@vm0/api-contracts/contracts/chat-event-rows";

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
  | { readonly kind: "valid"; readonly latestSeqId: number };

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
  let expectedSeqId = (snapshots[0]?.seqId ?? THREAD_START_SEQ_ID) + 1;
  for (const event of events) {
    if (event.seqId !== expectedSeqId) {
      return { kind: "invalid" };
    }
    try {
      const text = await readFile(join(args.directory, event.name), "utf8");
      if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
        return { kind: "invalid" };
      }
      const row = chatEventRowV4Schema.parse(JSON.parse(text.slice(0, -1)));
      if (row.chatThreadId !== args.threadId || row.seqId !== event.seqId) {
        return { kind: "invalid" };
      }
    } catch {
      return { kind: "invalid" };
    }
    expectedSeqId += 1;
  }

  const latestEvent = events.at(-1);
  if (latestEvent) {
    return { kind: "valid", latestSeqId: latestEvent.seqId };
  }
  const snapshot = snapshots[0];
  return snapshot
    ? { kind: "valid", latestSeqId: snapshot.seqId }
    : { kind: "invalid" };
}

async function downloadSnapshot(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Chat event snapshot download failed with status ${response.status}`,
    );
  }
  const text = await response.text();
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("Chat event snapshot must be newline-delimited JSON");
  }
  for (const line of text.slice(0, -1).split("\n")) {
    chatEventRowV4Schema.parse(JSON.parse(line));
  }
  return text;
}

async function syncRows(args: {
  readonly threadId: string;
  readonly directory: string;
  readonly sinceSeqId: number;
}): Promise<"complete" | "expired"> {
  let sinceSeqId = args.sinceSeqId;
  for (;;) {
    const page = await listZeroChatEventRows({
      threadId: args.threadId,
      sinceSeqId,
      limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
    });
    if (page.kind === "expired") {
      return "expired";
    }
    for (const [index, row] of page.rows.entries()) {
      if (row.seqId !== sinceSeqId + index + 1) {
        throw new Error("Chat event rows must have contiguous sequence IDs");
      }
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
      sinceSeqId = lastRow.seqId;
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
  // first leaves either a valid prefix or an invalid generation that the next
  // invocation rebuilds; no interrupted operation can commit a sparse cursor.
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
    let sinceSeqId = THREAD_START_SEQ_ID;
    if (snapshot) {
      const text = await downloadSnapshot(snapshot.url);
      await writeFile(
        join(temporaryDirectory, `snapshot-to-${snapshot.lastSeqId}.ndjson`),
        text,
        "utf8",
      );
      sinceSeqId = snapshot.lastSeqId;
    }

    const result = await syncRows({
      threadId: args.threadId,
      directory: temporaryDirectory,
      sinceSeqId,
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
      sinceSeqId: state.latestSeqId,
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
