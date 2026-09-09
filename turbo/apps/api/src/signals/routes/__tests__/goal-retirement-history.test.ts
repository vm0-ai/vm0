import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it } from "vitest";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  seedGoalRetirementHistory,
  applyGoalRetirementFixture,
  removeSnapshottedGoalFixtureEvents,
} from "../../../test-fixtures/goal-retirement";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createOpsLogsApi } from "./helpers/api-bdd-ops-logs";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";
import {
  installFakeChatEventR2,
  type RecordedChatEventPut,
} from "./helpers/fake-chat-event-r2";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const routeMocks = createRouteMocks(context);

function exportedZip(): AdmZip {
  for (const [command] of context.mocks.s3.send.mock.calls) {
    if (
      typeof command !== "object" ||
      command === null ||
      !("input" in command)
    ) {
      continue;
    }
    const input = command.input;
    if (
      typeof input !== "object" ||
      input === null ||
      !("Key" in input) ||
      !("Body" in input)
    ) {
      continue;
    }
    if (
      typeof input.Key === "string" &&
      input.Key.endsWith(".zip") &&
      Buffer.isBuffer(input.Body)
    ) {
      return new AdmZip(input.Body);
    }
  }
  throw new Error("Expected user export ZIP");
}

describe("retired Goal logical history", () => {
  const puts: RecordedChatEventPut[] = [];
  beforeEach(() => {
    puts.length = 0;
    mockEnv("GIT_COMMIT_SHA", "b".repeat(40));
    installFakeChatEventR2(context, puts);
    const handleSnapshot = context.mocks.s3.send.getMockImplementation();
    if (handleSnapshot === undefined) {
      throw new Error("Expected fake snapshot store");
    }
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (
        command instanceof GetObjectCommand &&
        !command.input.Key?.startsWith("chat-events/")
      ) {
        const bytes = command.input.Key?.endsWith("/manifest.json")
          ? Buffer.from(
              JSON.stringify({
                version: "fixture",
                createdAt: new Date(0).toISOString(),
                files: [],
                totalSize: 0,
                fileCount: 0,
              }),
            )
          : gzipSync(Buffer.alloc(1024));
        return Promise.resolve({
          Body: Readable.from([bytes]),
          ContentLength: bytes.length,
        });
      }
      return handleSnapshot(command);
    });
  });

  it("keeps exactly one full archive across migration retry, snapshot deletion and a new manual message", async () => {
    const actor = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(actor, {
      displayName: "Retirement history",
    });
    const thread = await chat.createThread(actor, { agentId: agent.agentId });
    const objective =
      " \n完整目标 🧭 e\u0301\t\r\n```\n'quoted'; $$ | </tag>\n```\n\n";
    // S1 rejects Goal creation. This narrowly scoped historical fixture executes
    // the actual migration; all observable assertions use production endpoints.
    await seedGoalRetirementHistory(thread.id, objective);
    await applyGoalRetirementFixture(thread.id);
    await applyGoalRetirementFixture(thread.id);
    const before = await chat.listThreadEvents(actor, thread.id);
    const archives = before.events.filter((event) => {
      return event.eventType === "output.message";
    });
    expect(archives).toHaveLength(1);
    expect(archives[0]?.content).toContain("Original recorded status: active");
    expect(archives[0]?.content?.endsWith(objective)).toBeTruthy();
    expect(
      before.events.filter((event) => {
        return event.eventType === "goal.close";
      }),
    ).toHaveLength(1);
    expect(archives[0]?.runId).toBeUndefined();

    await accept(
      setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
        testChatEventSearchProjectionContract,
      ).project({ body: { chat_thread_ids: [thread.id] } }),
      [200],
    );
    await accept(
      setupApp({ context, routes: testChatEventSnapshotRoutes })(
        testChatEventSnapshotContract,
      ).snapshot({
        body: { chat_thread_ids: [thread.id], r2_object_keys: [] },
      }),
      [200],
    );
    expect(puts.length).toBeGreaterThan(0);
    await removeSnapshottedGoalFixtureEvents(thread.id);
    await chat.requestListThreadEvents(actor, thread.id, {}, [410]);
    await applyGoalRetirementFixture(thread.id);
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const download = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      ).snapshot({
        headers: {
          authorization: "Bearer clerk-session",
          [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
            CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        },
        params: { threadId: thread.id },
      }),
      [200],
    );
    const cursor = download.body;
    if (cursor.lastEventId === null) {
      throw new Error("Expected nonempty retirement snapshot");
    }
    const snapshotPut = puts.at(-1);
    if (snapshotPut === undefined) {
      throw new Error("Expected snapshot publication");
    }
    const snapshotRows = gunzipSync(snapshotPut.body)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    expect(projectChatEventRows(snapshotRows)).toStrictEqual(before.events);
    const after = await chat.listThreadEvents(actor, thread.id, {
      sinceSeqId: cursor.lastSeqId,
      sinceEventId: cursor.lastEventId,
    });
    expect(after.events).toStrictEqual([]);

    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: thread.id,
        prompt: "Continue with a regular message",
      },
      [201],
    );
    expect(sent.status).toBe(201);
    const continued = await chat.listThreadEvents(actor, thread.id, {
      sinceSeqId: cursor.lastSeqId,
      sinceEventId: cursor.lastEventId,
    });
    expect(
      continued.events.filter((event) => {
        return event.eventType === "output.message";
      }),
    ).toStrictEqual([]);
    expect(
      continued.events.some((event) => {
        return event.eventType === "input.prompt";
      }),
    ).toBeTruthy();

    const exports = createOpsLogsApi(context);
    const started = await exports.requestPostUserExport(actor, [202]);
    await flushWaitUntilForTest();
    const status = await exports.requestGetUserExport(actor, [200]);
    expect(status.body.job).toMatchObject({
      id: started.body.jobId,
      status: "completed",
    });
    const entry = exportedZip().getEntry(
      `conversations/chat-thread-${thread.id}.json`,
    );
    expect(entry).not.toBeNull();
    const messages = JSON.parse(entry!.getData().toString("utf8")) as {
      role: string;
      content: string;
    }[];
    expect(
      messages.filter((message) => {
        return message.content === archives[0]?.content;
      }),
    ).toHaveLength(1);
    expect(
      messages.some((message) => {
        return message.content === "Continue with a regular message";
      }),
    ).toBeTruthy();
  }, 60_000);
});
