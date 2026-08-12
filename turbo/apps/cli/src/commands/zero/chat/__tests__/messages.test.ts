/**
 * Tests for okou chat messages command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend chat event route via MSW
 * - Real (internal): CLI argument parsing, pagination, API client, env handling
 */

import chalk from "chalk";
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
const SOURCE_THREAD_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ID = "00000000-0000-4000-8000-000000000020";
const EVENTS_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/events`;
const SOURCE_EVENTS_URL = `http://localhost:3000/api/okou/chat-threads/${SOURCE_THREAD_ID}/events`;
const FEATURE_SWITCHES_URL = "http://localhost:3000/api/okou/feature-switches";
const SNAPSHOT_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/event-snapshot`;
const ROWS_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/event-rows`;
const SNAPSHOT_DOWNLOAD_URL =
  "https://r2.example.test/chat-events/snapshot.ndjson.gz";

function featureSwitches(enabled: boolean) {
  return {
    switches: {},
    effectiveSwitches: { chatEventSnapshotRead: enabled },
  };
}

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

function promptEvent(args: {
  id: string;
  seqId: number;
  text: string;
  createdAt: string;
}) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "input.prompt" as const,
    content: null,
    userMessage: {
      version: 1 as const,
      parts: [{ type: "text" as const, text: args.text }],
    },
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: args.createdAt,
  };
}

function assistantEvent(args: {
  id: string;
  seqId: number;
  text: string;
  createdAt: string;
}) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "output.message" as const,
    content: args.text,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: args.createdAt,
  };
}

function thinkingEvent(args: { id: string; seqId: number }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "output.thinking" as const,
    content: null,
    thinking: "internal reasoning",
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: "2026-07-29T10:00:30.000Z",
  };
}

function automationEvent(args: { id: string; seqId: number; brief: string }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "input.automation" as const,
    content: null,
    userMessage: {
      version: 1 as const,
      parts: [
        {
          type: "automation" as const,
          workflowName: "daily-digest",
          automationBrief: args.brief,
        },
      ],
    },
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: "2026-07-29T08:00:00.000Z",
  };
}

function goalInputEvent(args: { id: string; seqId: number; brief: string }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "input.goal" as const,
    content: null,
    userMessage: {
      version: 1 as const,
      parts: [{ type: "goal" as const, goalBrief: args.brief }],
    },
    seqId: args.seqId,
    createdAt: "2026-07-29T08:01:00.000Z",
  };
}

function errorEvent(args: { id: string; seqId: number; error: string }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "output.error" as const,
    content: null,
    error: args.error,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: "2026-07-29T08:02:00.000Z",
  };
}

function runFailedEvent(args: { id: string; seqId: number; error: string }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "run.failed" as const,
    content: args.error,
    error: args.error,
    runLifecycleEvent: "failed" as const,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: "2026-07-29T08:03:00.000Z",
  };
}

function runCancelledEvent(args: { id: string; seqId: number }) {
  return {
    id: args.id,
    threadId: THREAD_ID,
    eventType: "run.cancelled" as const,
    content: null,
    runLifecycleEvent: "cancelled" as const,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: "2026-07-29T08:04:00.000Z",
  };
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    server.use(
      http.get(FEATURE_SWITCHES_URL, () => {
        return HttpResponse.json(featureSwitches(false));
      }),
    );
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
  });

  it("prints user and assistant messages oldest first and drops other events", async () => {
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        return HttpResponse.json({
          events: [
            promptEvent({
              id: "00000000-0000-4000-8000-000000000011",
              seqId: 1,
              text: "first delegated prompt",
              createdAt: "2026-07-29T10:00:00.000Z",
            }),
            thinkingEvent({
              id: "00000000-0000-4000-8000-000000000012",
              seqId: 2,
            }),
            assistantEvent({
              id: "00000000-0000-4000-8000-000000000013",
              seqId: 3,
              text: "done, here is the summary",
              createdAt: "2026-07-29T10:01:00.000Z",
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("User");
    expect(output).toContain("first delegated prompt");
    expect(output).toContain("Assistant");
    expect(output).toContain("done, here is the summary");
    expect(output).not.toContain("internal reasoning");
    expect(output.indexOf("first delegated prompt")).toBeLessThan(
      output.indexOf("done, here is the summary"),
    );
  });

  it("reads a source thread passed with --thread-id and prints JSON", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", undefined);
    server.use(
      http.get(SOURCE_EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            promptEvent({
              id: "00000000-0000-4000-8000-000000000014",
              seqId: 1,
              text: "delegate work to other chat threads",
              createdAt: "2026-07-29T09:00:00.000Z",
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--thread-id",
      SOURCE_THREAD_ID,
      "--json",
    ]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        threadId: SOURCE_THREAD_ID,
        total: 1,
        messages: [
          {
            eventId: "00000000-0000-4000-8000-000000000014",
            role: "user",
            createdAt: "2026-07-29T09:00:00.000Z",
            runId: RUN_ID,
            text: "delegate work to other chat threads",
          },
        ],
      },
    );
  });

  it("pages backwards until the limit is filled", async () => {
    const cursors: Array<string | null> = [];
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        const url = new URL(request.url);
        const beforeSeqId = url.searchParams.get("beforeSeqId");
        cursors.push(beforeSeqId);
        expect(url.searchParams.get("limit")).toBe("50");

        if (beforeSeqId === null) {
          return HttpResponse.json({
            events: [
              thinkingEvent({
                id: "00000000-0000-4000-8000-000000000015",
                seqId: 3,
              }),
              assistantEvent({
                id: "00000000-0000-4000-8000-000000000016",
                seqId: 4,
                text: "newest answer",
                createdAt: "2026-07-29T10:02:00.000Z",
              }),
            ],
          });
        }
        return HttpResponse.json({
          events: [
            promptEvent({
              id: "00000000-0000-4000-8000-000000000017",
              seqId: 1,
              text: "oldest question",
              createdAt: "2026-07-29T09:59:00.000Z",
            }),
            thinkingEvent({
              id: "00000000-0000-4000-8000-000000000018",
              seqId: 2,
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync([
      "node",
      "cli",
      "messages",
      "--limit",
      "2",
    ]);

    expect(cursors).toStrictEqual([null, "3"]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output.indexOf("oldest question")).toBeLessThan(
      output.indexOf("newest answer"),
    );
  });

  it("prints automation triggers, goal turns, and run errors", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            automationEvent({
              id: "00000000-0000-4000-8000-000000000021",
              seqId: 1,
              brief: "Gmail label applied",
            }),
            goalInputEvent({
              id: "00000000-0000-4000-8000-000000000022",
              seqId: 2,
              brief: "Merge PR #1",
            }),
            errorEvent({
              id: "00000000-0000-4000-8000-000000000023",
              seqId: 3,
              error: "Session history file not found",
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).not.toContain("No chat messages found");
    expect(output).toContain("[Automation: Gmail label applied]");
    expect(output).toContain("[Goal: Merge PR #1]");
    expect(output).toContain("Session history file not found");
  });

  it("prints the terminal error of a run that failed without answering", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            promptEvent({
              id: "00000000-0000-4000-8000-000000000025",
              seqId: 1,
              text: "delegated prompt",
              createdAt: "2026-07-29T08:02:30.000Z",
            }),
            runFailedEvent({
              id: "00000000-0000-4000-8000-000000000026",
              seqId: 2,
              error: "Agent exited before answering",
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).not.toContain("No chat messages found");
    expect(output).toContain("Agent exited before answering");
  });

  it("skips a terminal run event that carries no error", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            runCancelledEvent({
              id: "00000000-0000-4000-8000-000000000027",
              seqId: 1,
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("No chat messages found");
  });

  it("renders a claimed message once instead of alongside the row it revoked", async () => {
    const pendingId = "00000000-0000-4000-8000-000000000028";
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            promptEvent({
              id: pendingId,
              seqId: 1,
              text: "delegate work to other chat threads",
              createdAt: "2026-07-29T10:00:00.000Z",
            }),
            {
              ...promptEvent({
                id: "00000000-0000-4000-8000-000000000029",
                seqId: 2,
                text: "delegate work to other chat threads",
                createdAt: "2026-07-29T10:00:01.000Z",
              }),
              revokesEventId: pendingId,
            },
            assistantEvent({
              id: "00000000-0000-4000-8000-00000000002a",
              seqId: 3,
              text: "on it",
              createdAt: "2026-07-29T10:00:02.000Z",
            }),
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages", "--json"]);

    const payload = JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])) as {
      total: number;
      messages: readonly { eventId: string; text: string }[];
    };
    expect(payload.total).toBe(2);
    expect(
      payload.messages.map((message) => {
        return message.eventId;
      }),
    ).toStrictEqual([
      "00000000-0000-4000-8000-000000000029",
      "00000000-0000-4000-8000-00000000002a",
    ]);
  });

  it("renders attachments and mentions instead of reporting empty text", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            {
              id: "00000000-0000-4000-8000-000000000024",
              threadId: THREAD_ID,
              eventType: "input.prompt",
              content: null,
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "ask " },
                  {
                    type: "agent",
                    agentId: "00000000-0000-4000-8000-000000000030",
                    nameSnapshot: "Iris",
                  },
                  { type: "text", text: " about this" },
                  {
                    type: "file",
                    fileId: "file-1",
                    filenameSnapshot: "report.pdf",
                    contentType: "application/pdf",
                  },
                ],
              },
              runId: RUN_ID,
              seqId: 1,
              createdAt: "2026-07-29T10:00:00.000Z",
            },
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("ask [Agent: Iris] about this");
    expect(output).toContain("[File: report.pdf]");
    expect(output).not.toContain("(no message text)");
  });

  it("renders every feedback note part from the contract", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({
          events: [
            {
              id: "00000000-0000-4000-8000-000000000031",
              threadId: THREAD_ID,
              eventType: "input.prompt",
              content: null,
              userMessage: {
                version: 1,
                parts: [
                  {
                    type: "feedback",
                    quote: "Original answer",
                    note: [
                      { type: "text", text: "Compare " },
                      {
                        type: "chat_thread",
                        threadId: SOURCE_THREAD_ID,
                        titleSnapshot: "Source thread",
                      },
                      {
                        type: "agent",
                        agentId: "00000000-0000-4000-8000-000000000032",
                        nameSnapshot: "Iris",
                      },
                      {
                        type: "template",
                        titleSnapshot: "Launch deck",
                        template: {
                          type: "illustration",
                          selection: { illustrationStyleId: "editorial" },
                        },
                      },
                    ],
                  },
                ],
              },
              runId: RUN_ID,
              seqId: 1,
              createdAt: "2026-07-29T10:00:00.000Z",
            },
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      '[Feedback on "Original answer"] Compare [Chat thread: Source thread][Agent: Iris][Template: Launch deck]',
    );
  });

  it("guides to send when the thread has no messages", async () => {
    server.use(
      http.get(EVENTS_URL, () => {
        return HttpResponse.json({ events: [] });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "messages"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("No chat messages found");
    expect(output).toContain(`okou chat send --thread-id ${THREAD_ID}`);
  });

  it("synchronizes a snapshot and hot event files without reading projected events", async () => {
    const outputDirectory = await createOutputDirectory();
    const snapshotRows = [rawEventRow(1), rawEventRow(2)];
    const hotRow = rawEventRow(3);
    server.use(
      http.get(FEATURE_SWITCHES_URL, () => {
        return HttpResponse.json(featureSwitches(true));
      }),
      http.get(EVENTS_URL, () => {
        throw new Error("Projected events endpoint must not be called");
      }),
      http.get(SNAPSHOT_URL, () => {
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

  it("uses the latest local seq id for an incremental raw history sync", async () => {
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
      http.get(FEATURE_SWITCHES_URL, () => {
        return HttpResponse.json(featureSwitches(true));
      }),
      http.get(EVENTS_URL, () => {
        throw new Error("Projected events endpoint must not be called");
      }),
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
      http.get(FEATURE_SWITCHES_URL, () => {
        return HttpResponse.json(featureSwitches(true));
      }),
      http.get(EVENTS_URL, () => {
        throw new Error("Projected events endpoint must not be called");
      }),
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

  it("rebuilds an expired local generation and removes its managed files", async () => {
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
      http.get(FEATURE_SWITCHES_URL, () => {
        return HttpResponse.json(featureSwitches(true));
      }),
      http.get(EVENTS_URL, () => {
        throw new Error("Projected events endpoint must not be called");
      }),
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
