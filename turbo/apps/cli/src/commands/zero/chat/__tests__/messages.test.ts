import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/event-snapshot`;
const ROWS_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/event-rows`;
const SNAPSHOT_DOWNLOAD_URL =
  "https://r2.example.test/chat-events/snapshot.ndjson.gz";

function rawEventRow(seqId: number) {
  return {
    id: `00000000-0000-4000-8000-${String(seqId).padStart(12, "0")}`,
    chatThreadId: THREAD_ID,
    runId: null,
    revokesEventId: null,
    eventType: "output.message" as const,
    payload: { content: `message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}

function snapshotNdjson(rows: readonly ReturnType<typeof rawEventRow>[]) {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "okou-chat-messages-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

describe("okou chat messages command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("synchronizes a snapshot and hot event files", async () => {
    const outputDirectory = await createOutputDirectory();
    const snapshotRows = [rawEventRow(1), rawEventRow(2)];
    const hotRow = rawEventRow(3);
    server.use(
      http.get(SNAPSHOT_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        return HttpResponse.json({
          url: SNAPSHOT_DOWNLOAD_URL,
          expiresInSeconds: 900,
          lastSeqId: 2,
        });
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse(snapshotNdjson(snapshotRows));
      }),
      http.get(ROWS_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("sinceSeqId")).toBe("2");
        expect(url.searchParams.get("limit")).toBe("50");
        return HttpResponse.json({ rows: [hotRow] });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    const threadDirectory = join(outputDirectory, THREAD_ID);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      "event-SEQ_ID_3.json",
      "snapshot-to-2.ndjson",
    ]);
    await expect(
      readFile(join(threadDirectory, "snapshot-to-2.ndjson"), "utf8"),
    ).resolves.toBe(snapshotNdjson(snapshotRows));
    await expect(
      readFile(join(threadDirectory, "event-SEQ_ID_3.json"), "utf8"),
    ).resolves.toBe(`${JSON.stringify(hotRow)}\n`);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(join(threadDirectory, "snapshot-to-2.ndjson"));
    expect(output).toContain(join(threadDirectory, "event-SEQ_ID_3.json"));
  });

  it("uses the latest local seq id for an incremental sync", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_3.json"),
      `${JSON.stringify(rawEventRow(3))}\n`,
      "utf8",
    );
    const cursors: string[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        throw new Error("Snapshot endpoint must not be called");
      }),
      http.get(ROWS_URL, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (cursor === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push(cursor);
        return HttpResponse.json({ rows: [rawEventRow(4)] });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
      "--json",
    ]);

    expect(cursors).toStrictEqual(["3"]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      "event-SEQ_ID_3.json",
      "event-SEQ_ID_4.json",
      "snapshot-to-2.ndjson",
    ]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: THREAD_ID,
        directory: threadDirectory,
        files: [
          join(threadDirectory, "snapshot-to-2.ndjson"),
          join(threadDirectory, "event-SEQ_ID_3.json"),
          join(threadDirectory, "event-SEQ_ID_4.json"),
        ],
      },
    );
  });

  it("rebuilds a sparse local generation before advancing its cursor", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_4.json"),
      `${JSON.stringify(rawEventRow(4))}\n`,
      "utf8",
    );
    await writeFile(join(threadDirectory, "notes.txt"), "keep me", "utf8");
    const freshSnapshot = snapshotNdjson([rawEventRow(10)]);
    const cursors: string[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json({
          url: SNAPSHOT_DOWNLOAD_URL,
          expiresInSeconds: 900,
          lastSeqId: 10,
        });
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse(freshSnapshot);
      }),
      http.get(ROWS_URL, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (cursor === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push(cursor);
        expect(cursor).toBe("10");
        return HttpResponse.json({ rows: [rawEventRow(11)] });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    expect(cursors).toStrictEqual(["10"]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      "event-SEQ_ID_11.json",
      "notes.txt",
      "snapshot-to-10.ndjson",
    ]);
  });

  it("rebuilds an expired local generation and preserves unmanaged files", async () => {
    const outputDirectory = await createOutputDirectory();
    const threadDirectory = join(outputDirectory, THREAD_ID);
    await mkdir(threadDirectory, { recursive: true });
    await writeFile(
      join(threadDirectory, "snapshot-to-2.ndjson"),
      snapshotNdjson([rawEventRow(1), rawEventRow(2)]),
      "utf8",
    );
    await writeFile(
      join(threadDirectory, "event-SEQ_ID_3.json"),
      `${JSON.stringify(rawEventRow(3))}\n`,
      "utf8",
    );
    await writeFile(join(threadDirectory, "notes.txt"), "keep me", "utf8");
    const freshSnapshot = snapshotNdjson([rawEventRow(10)]);
    const cursors: string[] = [];
    server.use(
      http.get(SNAPSHOT_URL, () => {
        return HttpResponse.json({
          url: SNAPSHOT_DOWNLOAD_URL,
          expiresInSeconds: 900,
          lastSeqId: 10,
        });
      }),
      http.get(SNAPSHOT_DOWNLOAD_URL, () => {
        return new HttpResponse(freshSnapshot);
      }),
      http.get(ROWS_URL, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("sinceSeqId");
        if (cursor === null) {
          throw new Error("Expected a rows cursor");
        }
        cursors.push(cursor);
        if (cursor === "3") {
          return HttpResponse.json(
            {
              error: {
                code: "CHAT_EVENTS_EXPIRED",
                message: "Chat events cursor has expired",
              },
            },
            { status: 410 },
          );
        }
        expect(cursor).toBe("10");
        return HttpResponse.json({ rows: [rawEventRow(11)] });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--output-dir",
      outputDirectory,
    ]);

    expect(cursors).toStrictEqual(["3", "10"]);
    expect((await readdir(threadDirectory)).sort()).toStrictEqual([
      "event-SEQ_ID_11.json",
      "notes.txt",
      "snapshot-to-10.ndjson",
    ]);
    await expect(
      readFile(join(threadDirectory, "notes.txt"), "utf8"),
    ).resolves.toBe("keep me");
  });

  it("requires a thread ID from the flag or the current web chat", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);

    await expect(async () => {
      await zeroChatCommand.parseAsync(["node", "cli", "messages"]);
    }).rejects.toThrow("process.exit called");

    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stderr).toContain("OKOU_CHAT_THREAD_ID is not set");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
