import {
  mkdir,
  mkdtemp,
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
    await Promise.all(
      page.rows.map((row) => {
        return writeFile(
          join(args.directory, `event-SEQ_ID_${row.seqId}.json`),
          `${JSON.stringify(row)}\n`,
          "utf8",
        );
      }),
    );
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
  await Promise.all(
    existing.map((file) => {
      return rm(join(args.targetDirectory, file.name));
    }),
  );
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
  const latestSeqId =
    existing.length === 0
      ? undefined
      : Math.max(
          ...existing.map((file) => {
            return file.seqId;
          }),
        );

  if (latestSeqId === undefined) {
    await rebuildRawChatHistory({
      threadId: args.threadId,
      outputDirectory: args.outputDirectory,
      threadDirectory,
    });
  } else {
    const result = await syncRows({
      threadId: args.threadId,
      directory: threadDirectory,
      sinceSeqId: latestSeqId,
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
