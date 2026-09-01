import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { testChatEventSearchProjectionRoutes } from "../test-chat-event-search-projection";
import { testChatEventSnapshotRoutes } from "../test-chat-event-snapshot";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  ageFakeChatEventObject,
  deleteFakeChatEventObject,
  FAKE_CHAT_EVENT_SNAPSHOT_URL,
  installFakeChatEventR2,
  readFakeChatEventObject,
  writeFakeChatEventObject,
} from "./helpers/fake-chat-event-r2";
import {
  readChatEventRowsAsPreviousApiFixture,
  readChatEventSnapshotHead,
  updateChatEventSnapshotHead,
} from "./helpers/runtime-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const chat = createChatFilesBddApi(context);
// Manual objects share the fake R2 directory, so each test owns its teardown.
const trackFakeChatEventObject = createFixtureTracker(
  deleteFakeChatEventObject,
);

const R2_GC_SLOT_MS = 10 * 60 * 1000;
const R2_GC_SHARD_GROUP_COUNT = 16 ** 2;
const RETIRED_MORNING_BRIEF_CUTOVER_ERROR = "legacy_morning_brief_cutover";
const RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE =
  "This legacy Morning Brief was stopped during the Official Workflow cutover.";
const HISTORICAL_MORNING_BRIEF_SELECTED_MODEL = "claude-sonnet-5";
const HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL = "gpt-5.6-sol";
const HISTORICAL_MORNING_BRIEF_SERVICE_TIER = "priority";

function sanitizedLegacyControlRevokeLine(row: ChatEventRow): string {
  const invalidFields = [
    ...(row.eventType === "control.revoke" ? [] : ["eventType"]),
    ...(row.runId === null ? [] : ["runId"]),
    ...(row.revokesEventId === null ? ["revokesEventId"] : []),
    ...(row.contextType === "morning_brief" ? [] : ["contextType"]),
    ...(row.contextId === row.revokesEventId ? [] : ["contextId"]),
    ...(row.payload === null ? [] : ["payload"]),
    ...(row.runEventSequenceNumber === null ? [] : ["runEventSequenceNumber"]),
    ...(row.runEventId === null ? [] : ["runEventId"]),
  ];
  if (invalidFields.length > 0) {
    throw new Error(
      `Expected an exact historical queue-discard row; invalid fields: ${invalidFields.join(", ")}`,
    );
  }
  return `${JSON.stringify({
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: null,
    revokesEventId: row.revokesEventId,
    eventType: "control.revoke",
    payload: null,
    contextType: "morning_brief",
    contextId: row.contextId,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: row.seqId,
    createdAt: row.createdAt,
  })}\n`;
}

function isSanitizedLegacyChainedRoot(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    root.chatThreadId === row.chatThreadId &&
    root.eventType === "input.prompt" &&
    root.runId === null &&
    root.revokesEventId === null &&
    root.contextType === "morning_brief" &&
    root.contextId === root.id &&
    root.runEventSequenceNumber === null &&
    root.runEventId === null
  );
}

function isSanitizedLegacyChainedTarget(
  row: ChatEventRow,
  target: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    target.chatThreadId === row.chatThreadId &&
    target.eventType === "input.rejected" &&
    target.runId === null &&
    target.revokesEventId === root.id &&
    target.contextType === "morning_brief" &&
    target.contextId === root.id &&
    target.runEventSequenceNumber === 0 &&
    target.runEventId === null &&
    target.seqId < row.seqId
  );
}

function sanitizedLegacyChainedControlRevokeLine(
  row: ChatEventRow,
  target: ChatEventRow,
  root: ChatEventRow,
): string {
  if (
    row.eventType !== "control.revoke" ||
    row.runId !== null ||
    row.revokesEventId !== target.id ||
    row.contextType !== "morning_brief" ||
    row.contextId !== root.id ||
    row.contextId === row.revokesEventId ||
    row.payload !== null ||
    row.runEventSequenceNumber !== null ||
    row.runEventId !== null ||
    !isSanitizedLegacyChainedTarget(row, target, root) ||
    !isSanitizedLegacyChainedRoot(row, root) ||
    root.seqId >= target.seqId
  ) {
    throw new Error("Expected an exact historical chained recall row");
  }
  return `${JSON.stringify({
    id: row.id,
    chatThreadId: row.chatThreadId,
    runId: null,
    revokesEventId: target.id,
    eventType: "control.revoke",
    payload: null,
    contextType: "morning_brief",
    contextId: root.id,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: row.seqId,
    createdAt: row.createdAt,
  })}\n`;
}

function isSanitizedContextlessMorningBriefRoot(row: ChatEventRow): boolean {
  return (
    row.eventType === "input.prompt" &&
    row.runId === null &&
    row.revokesEventId === null &&
    row.contextType === "morning_brief" &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    row.payload !== null &&
    Object.keys(row.payload).length === 1 &&
    row.payload.userMessage !== undefined
  );
}

function isSanitizedContextlessMorningBriefClaim(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    row.id !== root.id &&
    row.chatThreadId === root.chatThreadId &&
    row.eventType === "input.prompt" &&
    row.runId !== null &&
    row.revokesEventId === root.id &&
    row.contextType === "morning_brief" &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    row.seqId > root.seqId &&
    row.createdAt > root.createdAt &&
    isDeepStrictEqual(row.payload, root.payload)
  );
}

function sanitizedLegacyContextlessMorningBriefClaimLines(
  root: ChatEventRow,
  claim: ChatEventRow,
): { readonly root: string; readonly claim: string } {
  if (
    !isSanitizedContextlessMorningBriefRoot(root) ||
    !isSanitizedContextlessMorningBriefClaim(claim, root)
  ) {
    throw new Error("Expected an exact historical contextless claim pair");
  }
  chatEventFromRow(root);
  chatEventFromRow(claim);
  const encode = (row: ChatEventRow): string => {
    return `${JSON.stringify({
      id: row.id,
      chatThreadId: row.chatThreadId,
      runId: row.runId,
      revokesEventId: row.revokesEventId,
      eventType: "input.prompt",
      payload: row.payload,
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
      seqId: row.seqId,
      createdAt: row.createdAt,
    })}\n`;
  };
  return { root: encode(root), claim: encode(claim) };
}

function sanitizedLegacyContextlessMorningBriefModelClaimLines(
  root: ChatEventRow,
  claim: ChatEventRow,
  selectedModel = HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
  serviceTier?: "priority",
): { readonly root: string; readonly claim: string } {
  const projectedRoot = chatEventFromRow(root);
  if (
    !isSanitizedContextlessMorningBriefRoot(root) ||
    projectedRoot.eventType !== "input.prompt" ||
    projectedRoot.userMessage.parts.some((part) => {
      return part.type === "model";
    }) ||
    claim.id === root.id ||
    claim.chatThreadId !== root.chatThreadId ||
    claim.eventType !== "input.prompt" ||
    claim.runId === null ||
    claim.revokesEventId !== root.id ||
    claim.contextType !== "morning_brief" ||
    claim.contextId !== null ||
    claim.runEventSequenceNumber !== null ||
    claim.runEventId !== null ||
    claim.seqId <= root.seqId ||
    claim.createdAt <= root.createdAt ||
    !isDeepStrictEqual(claim.payload, {
      userMessage: {
        version: 1,
        parts: [
          ...projectedRoot.userMessage.parts,
          {
            type: "model",
            selectedModel,
            ...(serviceTier === undefined ? {} : { serviceTier }),
          },
        ],
      },
    })
  ) {
    throw new Error(
      "Expected an exact historical contextless model-annotated claim pair",
    );
  }
  chatEventFromRow(claim);
  const encode = (row: ChatEventRow): string => {
    return `${JSON.stringify({
      id: row.id,
      chatThreadId: row.chatThreadId,
      runId: row.runId,
      revokesEventId: row.revokesEventId,
      eventType: "input.prompt",
      payload: row.payload,
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
      seqId: row.seqId,
      createdAt: row.createdAt,
    })}\n`;
  };
  return { root: encode(root), claim: encode(claim) };
}

function isSanitizedContextlessMorningBriefDirectRunPrompt(
  prompt: ChatEventRow,
): boolean {
  const projectedPrompt = chatEventFromRow(prompt);
  if (
    prompt.eventType !== "input.prompt" ||
    projectedPrompt.eventType !== "input.prompt"
  ) {
    return false;
  }
  const modelPart = projectedPrompt.userMessage.parts.at(-1);
  return (
    prompt.runId !== null &&
    prompt.revokesEventId === null &&
    prompt.contextType === "morning_brief" &&
    prompt.contextId === null &&
    prompt.runEventSequenceNumber === null &&
    prompt.runEventId === null &&
    projectedPrompt.userMessage.parts.length > 1 &&
    projectedPrompt.userMessage.parts.slice(0, -1).every((part) => {
      return part.type !== "model";
    }) &&
    modelPart?.type === "model" &&
    Object.keys(modelPart).length === 2 &&
    modelPart.selectedModel.length > 0
  );
}

function isSanitizedContextlessMorningBriefDirectRunTerminal(
  terminal: ChatEventRow,
  prompt: ChatEventRow,
): boolean {
  if (terminal.id === prompt.id || terminal.eventType !== "run.completed") {
    return false;
  }
  return (
    terminal.chatThreadId === prompt.chatThreadId &&
    terminal.runId === prompt.runId &&
    terminal.revokesEventId === null &&
    terminal.contextType === null &&
    terminal.contextId === null &&
    terminal.runEventSequenceNumber === null &&
    terminal.runEventId === null &&
    terminal.seqId > prompt.seqId &&
    terminal.createdAt > prompt.createdAt
  );
}

function sanitizedLegacyContextlessMorningBriefDirectRunLines(
  prompt: ChatEventRow,
  terminal: ChatEventRow,
): { readonly prompt: string; readonly terminal: string } {
  if (
    !isSanitizedContextlessMorningBriefDirectRunPrompt(prompt) ||
    !isSanitizedContextlessMorningBriefDirectRunTerminal(terminal, prompt)
  ) {
    throw new Error("Expected an exact historical direct Morning Brief Run");
  }
  chatEventFromRow(terminal);
  const encode = (row: ChatEventRow): string => {
    return `${JSON.stringify({
      id: row.id,
      chatThreadId: row.chatThreadId,
      runId: row.runId,
      revokesEventId: row.revokesEventId,
      eventType: row.eventType,
      payload: row.payload,
      contextType: row.contextType,
      contextId: row.contextId,
      runEventSequenceNumber: row.runEventSequenceNumber,
      runEventId: row.runEventId,
      seqId: row.seqId,
      createdAt: row.createdAt,
    })}\n`;
  };
  return { prompt: encode(prompt), terminal: encode(terminal) };
}

function isSanitizedContextlessMorningBriefRetirement(
  row: ChatEventRow,
  root: ChatEventRow,
): boolean {
  return (
    row.id !== root.id &&
    row.chatThreadId === root.chatThreadId &&
    row.eventType === "input.rejected" &&
    row.runId === null &&
    row.revokesEventId === root.id &&
    row.contextType === "morning_brief" &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    row.seqId > root.seqId &&
    row.createdAt > root.createdAt &&
    row.payload !== null &&
    Object.keys(row.payload).length === 2 &&
    row.payload.error === RETIRED_MORNING_BRIEF_CUTOVER_ERROR &&
    isDeepStrictEqual(row.payload.userMessage, root.payload?.userMessage)
  );
}

function isSanitizedContextlessMorningBriefRetirementCompanion(
  row: ChatEventRow,
  retirement: ChatEventRow,
): boolean {
  return (
    row.id !== retirement.id &&
    row.chatThreadId === retirement.chatThreadId &&
    row.eventType === "output.error" &&
    row.runId === null &&
    row.revokesEventId === null &&
    row.contextType === null &&
    row.contextId === null &&
    row.runEventSequenceNumber === null &&
    row.runEventId === null &&
    row.seqId === retirement.seqId + 1 &&
    Date.parse(row.createdAt) === Date.parse(retirement.createdAt) + 1 &&
    row.payload !== null &&
    Object.keys(row.payload).length === 2 &&
    row.payload.content === RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE &&
    row.payload.error === RETIRED_MORNING_BRIEF_CUTOVER_ERROR
  );
}

function sanitizedLegacyContextlessMorningBriefRetirementLines(
  root: ChatEventRow,
  retirement: ChatEventRow,
  companion: ChatEventRow,
): {
  readonly root: string;
  readonly retirement: string;
  readonly companion: string;
} {
  if (
    !isSanitizedContextlessMorningBriefRoot(root) ||
    !isSanitizedContextlessMorningBriefRetirement(retirement, root) ||
    !isSanitizedContextlessMorningBriefRetirementCompanion(
      companion,
      retirement,
    )
  ) {
    throw new Error("Expected an exact historical contextless retirement");
  }
  chatEventFromRow(root);
  chatEventFromRow(retirement);
  chatEventFromRow(companion);
  const encode = (row: ChatEventRow): string => {
    return `${JSON.stringify({
      id: row.id,
      chatThreadId: row.chatThreadId,
      runId: row.runId,
      revokesEventId: row.revokesEventId,
      eventType: row.eventType,
      payload: row.payload,
      contextType: row.contextType,
      contextId: row.contextId,
      runEventSequenceNumber: row.runEventSequenceNumber,
      runEventId: row.runEventId,
      seqId: row.seqId,
      createdAt: row.createdAt,
    })}\n`;
  };
  return {
    root: encode(root),
    retirement: encode(retirement),
    companion: encode(companion),
  };
}

function mockR2GcWindowForKey(key: string, after: Date): Date {
  const prefixStart = "chat-events/".length;
  const shardGroup = Number.parseInt(
    key.slice(prefixStart, prefixStart + 2),
    16,
  );
  const firstSlot = Math.ceil(after.getTime() / R2_GC_SLOT_MS);
  const slotOffset =
    (shardGroup -
      (firstSlot % R2_GC_SHARD_GROUP_COUNT) +
      R2_GC_SHARD_GROUP_COUNT) %
    R2_GC_SHARD_GROUP_COUNT;
  const aligned = new Date((firstSlot + slotOffset) * R2_GC_SLOT_MS);
  mockNow(aligned);
  return aligned;
}

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return {
    authorization: "Bearer clerk-session",
    [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
  };
}

function eventsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
  );
}

async function runSnapshotCron(
  chatThreadIds: readonly string[],
  r2ObjectKeys: readonly string[] = [],
) {
  const client = setupApp({
    context,
    routes: testChatEventSnapshotRoutes,
  })(testChatEventSnapshotContract);
  const response = await accept(
    client.snapshot({
      body: {
        chat_thread_ids: [...chatThreadIds],
        r2_object_keys: [...r2ObjectKeys],
      },
    }),
    [200],
  );
  return response.body;
}

async function projectChatEventSearch(
  ...chatThreadIds: readonly string[]
): Promise<void> {
  const client = setupApp({
    context,
    routes: testChatEventSearchProjectionRoutes,
  })(testChatEventSearchProjectionContract);
  await accept(
    client.project({ body: { chat_thread_ids: [...chatThreadIds] } }),
    [200],
  );
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  },
): Promise<string> {
  await api.ensureOrgModelProvider(actor);
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201 || sent.body.runId !== null) {
    throw new Error("Expected a no-credit send without a run");
  }
  return sent.body.threadId;
}

function requiredValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

type RevokingChatEventRow = ChatEventRow & {
  readonly revokesEventId: string;
};

function isRevokingChatEventRow(
  row: ChatEventRow,
): row is RevokingChatEventRow {
  return row.revokesEventId !== null;
}

function requiredRevokingRow(
  row: ChatEventRow | undefined,
  message: string,
): RevokingChatEventRow {
  if (row === undefined || !isRevokingChatEventRow(row)) {
    throw new Error(message);
  }
  return row;
}

type PromptChatEventRow = ChatEventRow & {
  readonly eventType: "input.prompt";
};

function isPromptChatEventRow(row: ChatEventRow): row is PromptChatEventRow {
  return row.eventType === "input.prompt";
}

function requiredPromptRow(
  row: ChatEventRow | undefined,
  message: string,
): PromptChatEventRow {
  if (row === undefined || !isPromptChatEventRow(row)) {
    throw new Error(message);
  }
  return row;
}

describe("chat event snapshot read endpoints", () => {
  beforeEach(() => {
    installFakeChatEventR2(context);
  });

  it("serves the current Snapshot version and its terminal cursor", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot download agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-download-${randomUUID()}`,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "Snapshot feedback quote",
            note: [{ type: "text", text: "Keep the canonical location." }],
            eventId: "snapshot-feedback-source-event",
            range: { start: 4, end: 13 },
          },
        ],
      },
    });

    const missing = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: {
        message: "Chat event snapshot not found",
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
      },
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const head = await readChatEventSnapshotHead(context, threadId);

    const download = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(download.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    expect(download.body).toStrictEqual({
      url: FAKE_CHAT_EVENT_SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastEventId: head.last_event_id,
      lastSeqId: head.last_seq_id,
    });

    const snapshotObject = readFakeChatEventObject(head.object_key);
    if (snapshotObject === undefined) {
      throw new Error("Expected the feedback snapshot object");
    }
    const archivedEvents = gunzipSync(snapshotObject)
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => {
        return chatEventFromRow(chatEventRowSchema.parse(JSON.parse(line)));
      });
    const archivedInput = archivedEvents.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (archivedInput?.eventType !== "input.prompt") {
      throw new Error("Expected the archived feedback input");
    }
    const archivedFeedback = archivedInput.userMessage.parts.find((part) => {
      return part.type === "feedback";
    });
    expect(archivedFeedback).toStrictEqual({
      type: "feedback",
      quote: "Snapshot feedback quote",
      note: [{ type: "text", text: "Keep the canonical location." }],
      eventId: "snapshot-feedback-source-event",
      range: { start: 4, end: 13 },
    });

    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toMatchObject({
      archive_schema_version: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
      last_event_id: head.last_event_id,
      last_seq_id: head.last_seq_id,
      object_key: head.object_key,
      snapshot_count: 1,
    });

    const stranger = bdd.user({ orgId: `org_${randomUUID()}` });
    const strangerResponse = await accept(
      eventsClient().snapshot({
        headers: authenticate(stranger),
        params: { threadId },
      }),
      [404],
    );
    expect(strangerResponse.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  }, 60_000);

  it("repairs retired Morning Brief documents and context-carrying revocations before cold download", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Morning Brief archive repair agent",
    });
    const markers = Array.from({ length: 9 }, (_, index) => {
      return `morning-brief-history-${(index + 1).toString()}-${randomUUID()}`;
    });
    let threadId: string | undefined;
    for (const marker of markers) {
      threadId = await sendNoCreditMessage(owner, {
        agentId: agent.agentId,
        ...(threadId === undefined ? {} : { threadId }),
        prompt: marker,
      });
    }
    if (threadId === undefined) {
      throw new Error("Expected a historical Morning Brief thread");
    }

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const originalHead = await readChatEventSnapshotHead(context, threadId);
    const originalObject = readFakeChatEventObject(originalHead.object_key);
    if (originalObject === undefined) {
      throw new Error("Expected an original Chat Event Snapshot object");
    }
    const originalRows = gunzipSync(originalObject)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    const promptRows = originalRows.filter((row) => {
      return row.eventType === "input.prompt";
    });
    expect(promptRows).toHaveLength(9);

    const runIds = markers.map(() => {
      return randomUUID();
    });
    const contextlessClaimRunId = randomUUID();
    const contextlessModelClaimRunId = randomUUID();
    const contextlessPriorityModelClaimRunId = randomUUID();
    const contextlessDirectRunId = randomUUID();
    const historicalDocuments: readonly UserMessageDocument[] = [
      {
        version: 1,
        parts: [
          {
            type: "source",
            kind: "github",
            href: "https://github.com/vm0-ai/vm0/issues/30675",
          },
          { type: "text", text: "Summarize today's priorities." },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: "historical-file",
            filenameSnapshot: "priorities.pdf",
            contentType: "application/pdf",
          },
          { type: "text", text: "Include the attached priorities." },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "chat_thread",
            threadId,
            titleSnapshot: "Launch planning",
          },
          { type: "text", text: "Carry forward the launch decisions." },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "template",
            titleSnapshot: "Editorial illustration",
            template: {
              type: "illustration",
              selection: { illustrationStyleId: "editorial" },
            },
          },
          {
            type: "text",
            text: "Illustrate the highest-priority update.",
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "feedback",
            quote: "The owner is still unclear.",
            note: [{ type: "text", text: "Name the owner." }],
          },
          { type: "text", text: "Finish the ownership summary." },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Preserve the terminal cutover explanation.",
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Preserve the authoritative Run model annotation.",
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Preserve the historical fast Run model annotation.",
          },
        ],
      },
      {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Preserve the pre-queue direct Morning Brief Run prompt.",
          },
        ],
      },
    ];
    const promptIndexById = new Map(
      promptRows.map((row, index) => {
        return [row.id, index] as const;
      }),
    );
    const rejectionRows = originalRows.filter((row) => {
      return row.eventType === "input.rejected";
    });
    const revocationFixtureMessage =
      "Expected complete historical revocation source rows";
    const contextlessClaimRow = requiredRevokingRow(
      rejectionRows[0],
      revocationFixtureMessage,
    );
    const directControlRevokeRow = requiredRevokingRow(
      rejectionRows[1],
      revocationFixtureMessage,
    );
    const chainedRejectionRow = requiredRevokingRow(
      rejectionRows[2],
      revocationFixtureMessage,
    );
    const chainedControlRevokeRow = requiredValue(
      rejectionRows[3],
      revocationFixtureMessage,
    );
    const contextOnlyRow = requiredValue(
      rejectionRows[4],
      revocationFixtureMessage,
    );
    const contextlessRetirementRow = requiredRevokingRow(
      rejectionRows[5],
      revocationFixtureMessage,
    );
    const contextlessModelClaimRow = requiredRevokingRow(
      rejectionRows[6],
      revocationFixtureMessage,
    );
    const contextlessPriorityModelClaimRow = requiredRevokingRow(
      rejectionRows[7],
      revocationFixtureMessage,
    );
    const contextlessDirectRunTerminalRow = requiredRevokingRow(
      rejectionRows[8],
      revocationFixtureMessage,
    );
    const contextlessRootRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === contextlessClaimRow.revokesEventId;
      }),
      "Expected the historical contextless root prompt",
    );
    const chainedRootRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === chainedRejectionRow.revokesEventId;
      }),
      "Expected the historical chained root prompt",
    );
    const contextlessRetirementRootRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === contextlessRetirementRow.revokesEventId;
      }),
      "Expected the historical contextless retirement root prompt",
    );
    const contextlessModelClaimRootRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === contextlessModelClaimRow.revokesEventId;
      }),
      "Expected the historical contextless model-annotated root prompt",
    );
    const contextlessPriorityModelClaimRootRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === contextlessPriorityModelClaimRow.revokesEventId;
      }),
      "Expected the historical contextless priority-model root prompt",
    );
    const contextlessDirectRunPromptRow = requiredPromptRow(
      originalRows.find((row) => {
        return row.id === contextlessDirectRunTerminalRow.revokesEventId;
      }),
      "Expected the historical direct Morning Brief Run prompt",
    );
    const contextlessRetirementCompanionRow = requiredValue(
      originalRows.find((row) => {
        return (
          row.eventType === "output.error" &&
          row.seqId === contextlessRetirementRow.seqId + 1
        );
      }),
      "Expected the historical contextless retirement companion",
    );
    const contextlessRootPromptIndex = promptIndexById.get(
      contextlessRootRow.id,
    );
    const contextlessDocument = requiredValue(
      contextlessRootPromptIndex === undefined
        ? undefined
        : historicalDocuments[contextlessRootPromptIndex],
      "Expected the contextless root document",
    );
    const contextlessRetirementRootPromptIndex = promptIndexById.get(
      contextlessRetirementRootRow.id,
    );
    const contextlessRetirementDocument = requiredValue(
      contextlessRetirementRootPromptIndex === undefined
        ? undefined
        : historicalDocuments[contextlessRetirementRootPromptIndex],
      "Expected the contextless retirement document",
    );
    const contextlessModelClaimRootPromptIndex = requiredValue(
      promptIndexById.get(contextlessModelClaimRootRow.id),
      "Expected the contextless model-annotated claim prompt index",
    );
    const contextlessModelClaimDocument = requiredValue(
      historicalDocuments[contextlessModelClaimRootPromptIndex],
      "Expected the contextless model-annotated claim document",
    );
    const contextlessPriorityModelClaimRootPromptIndex = requiredValue(
      promptIndexById.get(contextlessPriorityModelClaimRootRow.id),
      "Expected the contextless priority-model claim prompt index",
    );
    const contextlessPriorityModelClaimDocument = requiredValue(
      historicalDocuments[contextlessPriorityModelClaimRootPromptIndex],
      "Expected the contextless priority-model claim document",
    );
    const contextlessDirectRunPromptIndex = requiredValue(
      promptIndexById.get(contextlessDirectRunPromptRow.id),
      "Expected the direct Morning Brief Run prompt index",
    );
    const contextlessDirectRunDocument = requiredValue(
      historicalDocuments[contextlessDirectRunPromptIndex],
      "Expected the direct Morning Brief Run document",
    );
    const expectedSpecialRowsById = new Map<string, ChatEventRow>([
      [
        contextlessDirectRunPromptRow.id,
        chatEventRowSchema.parse({
          ...contextlessDirectRunPromptRow,
          eventType: "input.prompt",
          runId: contextlessDirectRunId,
          revokesEventId: null,
          contextType: "web",
          contextId: null,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessDirectRunDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
                },
              ],
            },
          },
          runEventSequenceNumber: null,
          runEventId: null,
        }),
      ],
      [
        contextlessDirectRunTerminalRow.id,
        chatEventRowSchema.parse({
          ...contextlessDirectRunTerminalRow,
          eventType: "run.completed",
          runId: contextlessDirectRunId,
          revokesEventId: null,
          contextType: null,
          contextId: null,
          payload: null,
          runEventSequenceNumber: null,
          runEventId: null,
        }),
      ],
      [
        contextOnlyRow.id,
        chatEventRowSchema.parse({
          ...contextOnlyRow,
          contextType: "web",
          contextId: null,
        }),
      ],
    ]);
    const expectedRows = originalRows.map((row): ChatEventRow => {
      const expectedSpecialRow = expectedSpecialRowsById.get(row.id);
      if (expectedSpecialRow !== undefined) {
        return expectedSpecialRow;
      }
      if (row.id === contextlessClaimRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "input.prompt",
          runId: contextlessClaimRunId,
          contextType: "web",
          contextId: null,
          payload: { userMessage: contextlessDocument },
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === contextlessModelClaimRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "input.prompt",
          runId: contextlessModelClaimRunId,
          contextType: "web",
          contextId: null,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessModelClaimDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
                },
              ],
            },
          },
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === contextlessPriorityModelClaimRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "input.prompt",
          runId: contextlessPriorityModelClaimRunId,
          contextType: "web",
          contextId: null,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessPriorityModelClaimDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
                  serviceTier: HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
                },
              ],
            },
          },
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === directControlRevokeRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "control.revoke",
          payload: null,
          contextType: "web",
          contextId: null,
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === chainedControlRevokeRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "control.revoke",
          payload: null,
          revokesEventId: chainedRejectionRow.id,
          contextType: "web",
          contextId: null,
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === contextlessRetirementRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "input.rejected",
          runId: null,
          revokesEventId: contextlessRetirementRootRow.id,
          contextType: "web",
          contextId: null,
          payload: {
            userMessage: contextlessRetirementDocument,
            error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
          },
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      if (row.id === contextlessRetirementCompanionRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          eventType: "output.error",
          runId: null,
          revokesEventId: null,
          contextType: null,
          contextId: null,
          payload: {
            content: RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE,
            error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
          },
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      const promptIndex = promptIndexById.get(row.id);
      if (promptIndex !== undefined) {
        const historicalDocument = historicalDocuments[promptIndex];
        const runId = runIds[promptIndex];
        if (historicalDocument === undefined || runId === undefined) {
          throw new Error("Expected a complete historical shape fixture");
        }
        return chatEventRowSchema.parse({
          ...row,
          runId:
            row.id === contextlessRootRow.id ||
            row.id === chainedRootRow.id ||
            row.id === contextlessRetirementRootRow.id ||
            row.id === contextlessModelClaimRootRow.id ||
            row.id === contextlessPriorityModelClaimRootRow.id
              ? null
              : runId,
          contextType: "web",
          contextId: null,
          payload: {
            ...row.payload,
            userMessage: historicalDocument,
          },
        });
      }
      if (row.id === chainedRejectionRow.id) {
        const rootPromptIndex = promptIndexById.get(chainedRootRow.id);
        const historicalDocument =
          rootPromptIndex === undefined
            ? undefined
            : historicalDocuments[rootPromptIndex];
        if (historicalDocument === undefined) {
          throw new Error("Expected the chained rejection root document");
        }
        return chatEventRowSchema.parse({
          ...row,
          contextType: "web",
          contextId: null,
          payload: {
            ...row.payload,
            userMessage: historicalDocument,
          },
        });
      }
      return row;
    });
    for (const row of expectedRows) {
      chatEventFromRow(row);
    }

    const staleRows = expectedRows.map((row): ChatEventRow => {
      if (
        row.id === contextlessRootRow.id ||
        row.id === contextlessClaimRow.id ||
        row.id === contextlessRetirementRootRow.id ||
        row.id === contextlessRetirementRow.id ||
        row.id === contextlessModelClaimRootRow.id ||
        row.id === contextlessModelClaimRow.id ||
        row.id === contextlessPriorityModelClaimRootRow.id ||
        row.id === contextlessPriorityModelClaimRow.id ||
        row.id === contextlessDirectRunPromptRow.id
      ) {
        return chatEventRowSchema.parse({
          ...row,
          contextType: "morning_brief",
          contextId: null,
        });
      }
      if (row.id === directControlRevokeRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          contextType: "morning_brief",
          contextId: row.revokesEventId,
        });
      }
      if (row.id === chainedControlRevokeRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          contextType: "morning_brief",
          contextId: chainedRootRow.id,
        });
      }
      const promptIndex = promptIndexById.get(row.id);
      if (promptIndex !== undefined) {
        const userMessage = historicalDocuments[promptIndex];
        if (userMessage === undefined) {
          throw new Error("Expected a historical document fixture");
        }
        return chatEventRowSchema.parse({
          ...row,
          contextType: "morning_brief",
          contextId: row.id,
          payload: {
            ...row.payload,
            userMessage: {
              ...userMessage,
              parts: [
                ...userMessage.parts,
                {
                  type: "morning_brief",
                  briefDate: `2026-08-${(20 + promptIndex).toString()}`,
                },
              ],
            },
          },
        });
      }
      if (row.id === chainedRejectionRow.id) {
        const rootPromptIndex = promptIndexById.get(chainedRootRow.id);
        const userMessage =
          rootPromptIndex === undefined
            ? undefined
            : historicalDocuments[rootPromptIndex];
        if (userMessage === undefined || rootPromptIndex === undefined) {
          throw new Error("Expected a chained rejection document fixture");
        }
        return chatEventRowSchema.parse({
          ...row,
          contextType: "morning_brief",
          contextId: chainedRootRow.id,
          payload: {
            ...row.payload,
            userMessage: {
              ...userMessage,
              parts: [
                ...userMessage.parts,
                {
                  type: "morning_brief",
                  briefDate: `2026-08-${(20 + rootPromptIndex).toString()}`,
                },
              ],
            },
          },
        });
      }
      return row.id === contextOnlyRow.id
        ? chatEventRowSchema.parse({
            ...row,
            contextType: "morning_brief",
            contextId: row.id,
          })
        : row;
    });
    const staleDirectControlRevoke = staleRows.find((row) => {
      return row.id === directControlRevokeRow.id;
    });
    const staleContextlessRoot = staleRows.find((row) => {
      return row.id === contextlessRootRow.id;
    });
    const staleContextlessClaim = staleRows.find((row) => {
      return row.id === contextlessClaimRow.id;
    });
    const staleChainedRejection = staleRows.find((row) => {
      return row.id === chainedRejectionRow.id;
    });
    const staleChainedControlRevoke = staleRows.find((row) => {
      return row.id === chainedControlRevokeRow.id;
    });
    const staleChainedRoot = staleRows.find((row) => {
      return row.id === chainedRootRow.id;
    });
    const staleContextlessRetirementRoot = staleRows.find((row) => {
      return row.id === contextlessRetirementRootRow.id;
    });
    const staleContextlessRetirement = staleRows.find((row) => {
      return row.id === contextlessRetirementRow.id;
    });
    const staleContextlessRetirementCompanion = staleRows.find((row) => {
      return row.id === contextlessRetirementCompanionRow.id;
    });
    const staleContextlessModelClaimRoot = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessModelClaimRootRow.id;
      }),
      "Expected a byte-exact contextless model-annotated claim root",
    );
    const staleContextlessModelClaim = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessModelClaimRow.id;
      }),
      "Expected a byte-exact contextless model-annotated claim",
    );
    const staleContextlessPriorityModelClaimRoot = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessPriorityModelClaimRootRow.id;
      }),
      "Expected a byte-exact contextless priority-model claim root",
    );
    const staleContextlessPriorityModelClaim = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessPriorityModelClaimRow.id;
      }),
      "Expected a byte-exact contextless priority-model claim",
    );
    const staleContextlessDirectRunPrompt = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessDirectRunPromptRow.id;
      }),
      "Expected a byte-exact direct Morning Brief Run prompt",
    );
    const staleContextlessDirectRunTerminal = requiredValue(
      staleRows.find((row) => {
        return row.id === contextlessDirectRunTerminalRow.id;
      }),
      "Expected a byte-exact direct Morning Brief Run terminal",
    );
    if (
      staleDirectControlRevoke === undefined ||
      staleContextlessRoot === undefined ||
      staleContextlessClaim === undefined ||
      staleChainedRejection === undefined ||
      staleChainedControlRevoke === undefined ||
      staleChainedRoot === undefined ||
      staleContextlessRetirementRoot === undefined ||
      staleContextlessRetirement === undefined ||
      staleContextlessRetirementCompanion === undefined
    ) {
      throw new Error("Expected byte-exact historical revocation rows");
    }
    const byteExactDirectRevokeLine = sanitizedLegacyControlRevokeLine(
      staleDirectControlRevoke,
    );
    const byteExactChainedRevokeLine = sanitizedLegacyChainedControlRevokeLine(
      staleChainedControlRevoke,
      staleChainedRejection,
      staleChainedRoot,
    );
    const byteExactContextlessClaimLines =
      sanitizedLegacyContextlessMorningBriefClaimLines(
        staleContextlessRoot,
        staleContextlessClaim,
      );
    const byteExactContextlessRetirementLines =
      sanitizedLegacyContextlessMorningBriefRetirementLines(
        staleContextlessRetirementRoot,
        staleContextlessRetirement,
        staleContextlessRetirementCompanion,
      );
    const byteExactContextlessModelClaimLines =
      sanitizedLegacyContextlessMorningBriefModelClaimLines(
        staleContextlessModelClaimRoot,
        staleContextlessModelClaim,
      );
    const byteExactContextlessPriorityModelClaimLines =
      sanitizedLegacyContextlessMorningBriefModelClaimLines(
        staleContextlessPriorityModelClaimRoot,
        staleContextlessPriorityModelClaim,
        HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
        HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
      );
    const byteExactContextlessDirectRunLines =
      sanitizedLegacyContextlessMorningBriefDirectRunLines(
        staleContextlessDirectRunPrompt,
        staleContextlessDirectRunTerminal,
      );
    const staleArchive = Buffer.from(
      staleRows
        .map((row) => {
          if (row.id === contextlessRootRow.id) {
            return byteExactContextlessClaimLines.root;
          }
          if (row.id === contextlessClaimRow.id) {
            return byteExactContextlessClaimLines.claim;
          }
          if (row.id === directControlRevokeRow.id) {
            return byteExactDirectRevokeLine;
          }
          if (row.id === contextlessRetirementRootRow.id) {
            return byteExactContextlessRetirementLines.root;
          }
          if (row.id === contextlessRetirementRow.id) {
            return byteExactContextlessRetirementLines.retirement;
          }
          if (row.id === contextlessRetirementCompanionRow.id) {
            return byteExactContextlessRetirementLines.companion;
          }
          if (row.id === contextlessModelClaimRootRow.id) {
            return byteExactContextlessModelClaimLines.root;
          }
          if (row.id === contextlessModelClaimRow.id) {
            return byteExactContextlessModelClaimLines.claim;
          }
          if (row.id === contextlessPriorityModelClaimRootRow.id) {
            return byteExactContextlessPriorityModelClaimLines.root;
          }
          if (row.id === contextlessPriorityModelClaimRow.id) {
            return byteExactContextlessPriorityModelClaimLines.claim;
          }
          if (row.id === contextlessDirectRunPromptRow.id) {
            return byteExactContextlessDirectRunLines.prompt;
          }
          if (row.id === contextlessDirectRunTerminalRow.id) {
            return byteExactContextlessDirectRunLines.terminal;
          }
          return row.id === chainedControlRevokeRow.id
            ? byteExactChainedRevokeLine
            : `${JSON.stringify(row)}\n`;
        })
        .join(""),
    );
    expect(
      staleArchive.includes(Buffer.from(byteExactDirectRevokeLine)),
    ).toBeTruthy();
    expect(
      staleArchive.includes(Buffer.from(byteExactChainedRevokeLine)),
    ).toBeTruthy();
    expect(
      staleArchive.includes(
        Buffer.from(
          `${byteExactContextlessClaimLines.root}${byteExactContextlessClaimLines.claim}`,
        ),
      ),
    ).toBeTruthy();
    expect(
      staleArchive.includes(
        Buffer.from(
          `${byteExactContextlessPriorityModelClaimLines.root}${byteExactContextlessPriorityModelClaimLines.claim}`,
        ),
      ),
    ).toBeTruthy();
    expect(
      staleArchive.includes(
        Buffer.from(
          `${byteExactContextlessRetirementLines.root}${byteExactContextlessRetirementLines.retirement}${byteExactContextlessRetirementLines.companion}`,
        ),
      ),
    ).toBeTruthy();
    expect(
      staleArchive.includes(
        Buffer.from(
          `${byteExactContextlessModelClaimLines.root}${byteExactContextlessModelClaimLines.claim}`,
        ),
      ),
    ).toBeTruthy();
    expect(
      staleArchive.includes(
        Buffer.from(
          `${byteExactContextlessDirectRunLines.prompt}${byteExactContextlessDirectRunLines.terminal}`,
        ),
      ),
    ).toBeTruthy();
    const staleBody = gzipSync(staleArchive);
    const staleObjectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-${createHash("sha256").update(staleBody).digest("hex")}.ndjson.gz`;
    writeFakeChatEventObject(staleObjectKey, staleBody);
    await trackFakeChatEventObject(Promise.resolve(staleObjectKey));
    await updateChatEventSnapshotHead(context, threadId, staleObjectKey);

    const hotMarker = `hot-after-snapshot-${randomUUID()}`;
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: hotMarker,
    });
    const canonicalRowsBeforeRepair =
      await readChatEventRowsAsPreviousApiFixture(context, threadId);

    const download = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    const repairedHead = await readChatEventSnapshotHead(context, threadId);
    expect(repairedHead.object_key).toMatch(
      new RegExp(
        `^chat-events/${threadId}/${originalHead.last_seq_id.toString()}-r1-[0-9a-f]{64}\\.ndjson\\.gz$`,
        "u",
      ),
    );
    expect(repairedHead.object_key).not.toBe(staleObjectKey);
    expect(readFakeChatEventObject(staleObjectKey)).toStrictEqual(staleBody);

    const repairedObject = readFakeChatEventObject(repairedHead.object_key);
    if (repairedObject === undefined) {
      throw new Error("Expected a repaired Chat Event Snapshot object");
    }
    const repairedRows = gunzipSync(repairedObject)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    expect(repairedRows).toStrictEqual(expectedRows);
    expect(
      repairedRows.some((row) => {
        return row.contextType === "morning_brief";
      }),
    ).toBeFalsy();
    expect(
      repairedRows.map((row) => {
        return {
          id: row.id,
          eventType: row.eventType,
          seqId: row.seqId,
          runId: row.runId,
          revokesEventId: row.revokesEventId,
          runEventSequenceNumber: row.runEventSequenceNumber,
          runEventId: row.runEventId,
          payload: row.payload,
        };
      }),
    ).toStrictEqual(
      expectedRows.map((row) => {
        return {
          id: row.id,
          eventType: row.eventType,
          seqId: row.seqId,
          runId: row.runId,
          revokesEventId: row.revokesEventId,
          runEventSequenceNumber: row.runEventSequenceNumber,
          runEventId: row.runEventId,
          payload: row.payload,
        };
      }),
    );
    expect(
      repairedRows.find((row) => {
        return row.id === directControlRevokeRow.id;
      }),
    ).toMatchObject({
      eventType: "control.revoke",
      payload: null,
      contextType: "web",
      contextId: null,
      revokesEventId: directControlRevokeRow.revokesEventId,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === chainedControlRevokeRow.id;
      }),
    ).toMatchObject({
      eventType: "control.revoke",
      payload: null,
      contextType: "web",
      contextId: null,
      revokesEventId: chainedRejectionRow.id,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessRootRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: null,
      revokesEventId: null,
      contextType: "web",
      contextId: null,
      payload: { userMessage: contextlessDocument },
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessClaimRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: contextlessClaimRunId,
      revokesEventId: contextlessRootRow.id,
      contextType: "web",
      contextId: null,
      payload: { userMessage: contextlessDocument },
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessModelClaimRootRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: null,
      revokesEventId: null,
      contextType: "web",
      contextId: null,
      payload: { userMessage: contextlessModelClaimDocument },
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessModelClaimRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: contextlessModelClaimRunId,
      revokesEventId: contextlessModelClaimRootRow.id,
      contextType: "web",
      contextId: null,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessModelClaimDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
            },
          ],
        },
      },
      runEventSequenceNumber: null,
      runEventId: null,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessPriorityModelClaimRootRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: null,
      revokesEventId: null,
      contextType: "web",
      contextId: null,
      payload: { userMessage: contextlessPriorityModelClaimDocument },
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessPriorityModelClaimRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: contextlessPriorityModelClaimRunId,
      revokesEventId: contextlessPriorityModelClaimRootRow.id,
      contextType: "web",
      contextId: null,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessPriorityModelClaimDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
              serviceTier: HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
            },
          ],
        },
      },
      runEventSequenceNumber: null,
      runEventId: null,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessDirectRunPromptRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: contextlessDirectRunId,
      revokesEventId: null,
      contextType: "web",
      contextId: null,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessDirectRunDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
            },
          ],
        },
      },
      runEventSequenceNumber: null,
      runEventId: null,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessDirectRunTerminalRow.id;
      }),
    ).toMatchObject({
      eventType: "run.completed",
      runId: contextlessDirectRunId,
      revokesEventId: null,
      contextType: null,
      contextId: null,
      payload: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessRetirementRootRow.id;
      }),
    ).toMatchObject({
      eventType: "input.prompt",
      runId: null,
      revokesEventId: null,
      contextType: "web",
      contextId: null,
      payload: { userMessage: contextlessRetirementDocument },
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessRetirementRow.id;
      }),
    ).toMatchObject({
      eventType: "input.rejected",
      runId: null,
      revokesEventId: contextlessRetirementRootRow.id,
      contextType: "web",
      contextId: null,
      payload: {
        userMessage: contextlessRetirementDocument,
        error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
      },
      runEventSequenceNumber: null,
      runEventId: null,
    });
    expect(
      repairedRows.find((row) => {
        return row.id === contextlessRetirementCompanionRow.id;
      }),
    ).toMatchObject({
      eventType: "output.error",
      runId: null,
      revokesEventId: null,
      contextType: null,
      contextId: null,
      payload: {
        content: RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE,
        error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
      },
      runEventSequenceNumber: null,
      runEventId: null,
    });

    const projectedSnapshot = repairedRows.map(chatEventFromRow);
    const projectedPrompts = projectedSnapshot.filter((event) => {
      return event.eventType === "input.prompt";
    });
    const expectedPromptRows = expectedRows.filter((row) => {
      return row.eventType === "input.prompt";
    });
    expect(expectedPromptRows).toHaveLength(12);
    expect(
      projectedPrompts.map((event) => {
        return {
          id: event.id,
          runId: event.runId,
          revokesEventId: event.revokesEventId,
          userMessage: event.userMessage,
        };
      }),
    ).toStrictEqual(
      expectedPromptRows.map((row) => {
        return {
          id: row.id,
          runId: row.runId ?? undefined,
          revokesEventId: row.revokesEventId ?? undefined,
          userMessage: row.payload?.userMessage,
        };
      }),
    );

    if (download.body.lastEventId === null) {
      throw new Error("Expected a non-empty repaired Snapshot cursor");
    }
    const hot = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceEventId: download.body.lastEventId,
          sinceSeqId: download.body.lastSeqId,
        },
      }),
      [200],
    );
    const projectedColdHistory = [
      ...projectedSnapshot,
      ...hot.body.rows.map(chatEventFromRow),
    ];
    expect(JSON.stringify(projectedColdHistory)).toContain(hotMarker);
    await expect(
      readChatEventRowsAsPreviousApiFixture(context, threadId),
    ).resolves.toStrictEqual(canonicalRowsBeforeRepair);

    const replay = await accept(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
      [200],
    );
    expect(replay.body).toStrictEqual(download.body);
    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toStrictEqual(repairedHead);
    expect(readFakeChatEventObject(repairedHead.object_key)).toStrictEqual(
      repairedObject,
    );
  }, 90_000);

  it("fails closed without moving the pointer for malformed or future archive shapes", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Malformed Morning Brief archive agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `malformed-morning-brief-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const originalHead = await readChatEventSnapshotHead(context, threadId);
    const originalObject = readFakeChatEventObject(originalHead.object_key);
    if (originalObject === undefined) {
      throw new Error("Expected a Snapshot object for the malformed fixture");
    }
    const rows = gunzipSync(originalObject)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    const prompt = rows.find((row) => {
      return row.eventType === "input.prompt";
    });
    if (prompt === undefined) {
      throw new Error("Expected a malformed historical prompt fixture");
    }
    const staleRows = rows.map((row) => {
      return row.id === prompt.id
        ? chatEventRowSchema.parse({
            ...row,
            contextType: "morning_brief",
            contextId: row.id,
            payload: {
              ...row.payload,
              userMessage: {
                version: 1,
                parts: [
                  { type: "text", text: "Preserve this visible prompt." },
                  {
                    type: "morning_brief",
                    briefDate: "2026-08-24",
                    unexpected: true,
                  },
                ],
              },
            },
          })
        : row;
    });
    const staleBody = gzipSync(
      Buffer.from(
        staleRows
          .map((row) => {
            return `${JSON.stringify(row)}\n`;
          })
          .join(""),
      ),
    );
    const staleObjectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-${createHash("sha256").update(staleBody).digest("hex")}.ndjson.gz`;
    writeFakeChatEventObject(staleObjectKey, staleBody);
    await trackFakeChatEventObject(Promise.resolve(staleObjectKey));
    await updateChatEventSnapshotHead(context, threadId, staleObjectKey);
    const staleHead = await readChatEventSnapshotHead(context, threadId);

    await expect(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toStrictEqual(staleHead);

    const rejected = rows.find((row) => {
      return row.eventType === "input.rejected";
    });
    if (rejected === undefined || rejected.revokesEventId === null) {
      throw new Error("Expected a malformed historical revocation fixture");
    }
    const broadControlBody = gzipSync(
      Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(
              row.id === rejected.id
                ? chatEventRowSchema.parse({
                    ...row,
                    eventType: "control.revoke",
                    payload: {},
                    contextType: "morning_brief",
                    contextId: row.revokesEventId,
                  })
                : row,
            )}\n`;
          })
          .join(""),
      ),
    );
    const broadControlKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-${createHash("sha256").update(broadControlBody).digest("hex")}.ndjson.gz`;
    writeFakeChatEventObject(broadControlKey, broadControlBody);
    await trackFakeChatEventObject(Promise.resolve(broadControlKey));
    await updateChatEventSnapshotHead(context, threadId, broadControlKey);
    const broadControlHead = await readChatEventSnapshotHead(context, threadId);
    await expect(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toStrictEqual(broadControlHead);

    const futureObjectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-r2-${createHash("sha256").update(originalObject).digest("hex")}.ndjson.gz`;
    writeFakeChatEventObject(futureObjectKey, originalObject);
    await trackFakeChatEventObject(Promise.resolve(futureObjectKey));
    await updateChatEventSnapshotHead(context, threadId, futureObjectKey);
    const futureHead = await readChatEventSnapshotHead(context, threadId);
    await expect(
      eventsClient().snapshot({
        headers: authenticate(owner),
        params: { threadId },
      }),
    ).rejects.toThrow("Unknown response status 500");
    await expect(
      readChatEventSnapshotHead(context, threadId),
    ).resolves.toStrictEqual(futureHead);
  }, 60_000);

  it("classifies legacy Snapshot decode failures without logging row data", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot decode classification agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-decode-classification-${randomUUID()}`,
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-semantic-reorder-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);
    const originalHead = await readChatEventSnapshotHead(context, threadId);
    const originalObject = readFakeChatEventObject(originalHead.object_key);
    if (originalObject === undefined) {
      throw new Error("Expected a Snapshot object for decode classification");
    }
    const originalBody = gunzipSync(originalObject);
    const originalRows = originalBody
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        return chatEventRowSchema.parse(JSON.parse(line));
      });
    const inputRows = originalRows.filter((row) => {
      return row.eventType === "input.prompt";
    });
    const rejectedRows = originalRows.filter((row) => {
      return row.eventType === "input.rejected";
    });
    const inputRow = inputRows[0];
    const rejectedRow = rejectedRows[0];
    const semanticRootRow = inputRows[1];
    const semanticTerminalRow = rejectedRows[1];
    const contextlessRetirementCompanionSource = originalRows.find((row) => {
      return (
        rejectedRow !== undefined &&
        row.eventType === "output.error" &&
        row.seqId === rejectedRow.seqId + 1
      );
    });
    const firstRow = originalRows[0];
    if (
      inputRow === undefined ||
      rejectedRow === undefined ||
      semanticRootRow === undefined ||
      semanticTerminalRow === undefined ||
      contextlessRetirementCompanionSource === undefined ||
      rejectedRow.seqId >= semanticRootRow.seqId ||
      semanticRootRow.seqId >= semanticTerminalRow.seqId ||
      firstRow === undefined
    ) {
      throw new Error("Expected complete Snapshot decode fixtures");
    }
    const encodeRows = (rows: readonly unknown[]): Buffer => {
      return Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(row)}\n`;
          })
          .join(""),
      );
    };
    const rawRowBody = Buffer.from(
      `${JSON.stringify({ ...firstRow, unexpected: true })}\n`,
    );
    const projectionBody = encodeRows(
      originalRows.map((row) => {
        return row.id === inputRow.id ? { ...row, payload: null } : row;
      }),
    );
    const contextlessDocument: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "text",
          text: "Sanitized historical queued Morning Brief prompt.",
        },
      ],
    };
    const contextlessRoot = chatEventRowSchema.parse({
      ...inputRow,
      runId: null,
      revokesEventId: null,
      eventType: "input.prompt",
      payload: { userMessage: contextlessDocument },
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const contextlessClaim = chatEventRowSchema.parse({
      ...rejectedRow,
      runId: randomUUID(),
      revokesEventId: contextlessRoot.id,
      eventType: "input.prompt",
      payload: { userMessage: contextlessDocument },
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const contextlessModelClaim = chatEventRowSchema.parse({
      ...contextlessClaim,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
            },
          ],
        },
      },
    });
    const contextlessPriorityModelClaim = chatEventRowSchema.parse({
      ...contextlessModelClaim,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
              serviceTier: HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
            },
          ],
        },
      },
    });
    const contextlessDirectRunId = randomUUID();
    const contextlessDirectRunPrompt = chatEventRowSchema.parse({
      ...inputRow,
      runId: contextlessDirectRunId,
      revokesEventId: null,
      eventType: "input.prompt",
      payload: {
        userMessage: {
          version: 1,
          parts: [
            ...contextlessDocument.parts,
            {
              type: "model",
              selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
            },
          ],
        },
      },
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const contextlessDirectRunTerminal = chatEventRowSchema.parse({
      ...rejectedRow,
      runId: contextlessDirectRunId,
      revokesEventId: null,
      eventType: "run.completed",
      payload: null,
      contextType: null,
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const contextlessRetirement = chatEventRowSchema.parse({
      ...rejectedRow,
      runId: null,
      revokesEventId: contextlessRoot.id,
      eventType: "input.rejected",
      payload: {
        userMessage: contextlessDocument,
        error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
      },
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const contextlessRetirementCompanion = chatEventRowSchema.parse({
      ...contextlessRetirementCompanionSource,
      runId: null,
      revokesEventId: null,
      eventType: "output.error",
      payload: {
        content: RETIRED_MORNING_BRIEF_CUTOVER_MESSAGE,
        error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
      },
      contextType: null,
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    if (
      contextlessRoot.seqId >= contextlessClaim.seqId ||
      contextlessRoot.createdAt >= contextlessClaim.createdAt
    ) {
      throw new Error("Expected an ordered contextless claim fixture");
    }
    sanitizedLegacyContextlessMorningBriefRetirementLines(
      contextlessRoot,
      contextlessRetirement,
      contextlessRetirementCompanion,
    );
    sanitizedLegacyContextlessMorningBriefModelClaimLines(
      contextlessRoot,
      contextlessModelClaim,
    );
    sanitizedLegacyContextlessMorningBriefModelClaimLines(
      contextlessRoot,
      contextlessPriorityModelClaim,
      HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
      HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
    );
    sanitizedLegacyContextlessMorningBriefDirectRunLines(
      contextlessDirectRunPrompt,
      contextlessDirectRunTerminal,
    );
    const contextlessRows = (
      root: ChatEventRow,
      claim: ChatEventRow,
      additionalRevoker?: ChatEventRow,
    ): readonly ChatEventRow[] => {
      return originalRows.map((row) => {
        if (row.id === root.id) {
          return root;
        }
        if (row.id === claim.id) {
          return claim;
        }
        return row.id === additionalRevoker?.id ? additionalRevoker : row;
      });
    };
    const contextlessRetirementRows = (
      root: ChatEventRow,
      retirement: ChatEventRow,
      companion: ChatEventRow,
      additionalRow?: ChatEventRow,
    ): readonly ChatEventRow[] => {
      return originalRows.map((row) => {
        if (row.id === root.id) {
          return root;
        }
        if (row.id === retirement.id) {
          return retirement;
        }
        if (row.id === companion.id) {
          return companion;
        }
        return row.id === additionalRow?.id ? additionalRow : row;
      });
    };
    const contextlessDirectRunRows = (
      prompt: ChatEventRow,
      terminal: ChatEventRow,
      additionalRow?: ChatEventRow,
    ): readonly ChatEventRow[] => {
      return originalRows.map((row) => {
        if (row.id === contextlessDirectRunPrompt.id) {
          return prompt;
        }
        if (row.id === contextlessDirectRunTerminal.id) {
          return terminal;
        }
        return row.id === additionalRow?.id ? additionalRow : row;
      });
    };
    const missingPredecessorBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessClaim,
          revokesEventId: randomUUID(),
        }),
      ),
    );
    const mismatchedDocumentBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessClaim,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Sanitized mismatched historical prompt.",
                },
              ],
            },
          },
        }),
      ),
    );
    const unownedClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({ ...contextlessClaim, runId: null }),
      ),
    );
    const invalidClaimOrderBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessClaim,
          createdAt: contextlessRoot.createdAt,
        }),
      ),
    );
    const multipleRevokersBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        contextlessClaim,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          revokesEventId: contextlessRoot.id,
        }),
      ),
    );
    const duplicateContextlessIdBody = encodeRows(
      originalRows.map((row) => {
        if (row.id === contextlessRoot.id) {
          return contextlessRoot;
        }
        if (row.id === contextlessClaim.id) {
          return contextlessClaim;
        }
        return row.id === semanticRootRow.id
          ? chatEventRowSchema.parse({
              ...semanticRootRow,
              id: contextlessRoot.id,
            })
          : row;
      }),
    );
    const missingModelClaimPredecessorBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          revokesEventId: randomUUID(),
        }),
      ),
    );
    const mismatchedModelClaimPayloadBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Sanitized mismatched model-annotated prompt.",
                },
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
                  serviceTier: HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
                },
              ],
            },
          },
        }),
      ),
    );
    const reorderedModelClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          createdAt: contextlessRoot.createdAt,
        }),
      ),
    );
    const crossThreadModelClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          chatThreadId: randomUUID(),
        }),
      ),
    );
    const malformedModelClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
                  serviceTier: HISTORICAL_MORNING_BRIEF_SERVICE_TIER,
                },
                ...contextlessDocument.parts,
              ],
            },
          },
        }),
      ),
    );
    const ambiguousModelClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        contextlessPriorityModelClaim,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          revokesEventId: contextlessRoot.id,
        }),
      ),
    );
    const duplicateModelClaimIdBody = encodeRows(
      originalRows.map((row) => {
        if (row.id === contextlessRoot.id) {
          return contextlessRoot;
        }
        if (row.id === contextlessPriorityModelClaim.id) {
          return contextlessPriorityModelClaim;
        }
        return row.id === semanticRootRow.id
          ? chatEventRowSchema.parse({
              ...semanticRootRow,
              id: contextlessRoot.id,
            })
          : row;
      }),
    );
    const futureModelClaimBody = encodeRows(
      contextlessRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessPriorityModelClaim,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_FAST_SELECTED_MODEL,
                  serviceTier: "priority",
                  writerRevision: 2,
                },
              ],
            },
          },
        }),
      ),
    );
    const missingDirectRunTerminalBody = encodeRows(
      contextlessDirectRunRows(contextlessDirectRunPrompt, rejectedRow),
    );
    const crossThreadDirectRunTerminalBody = encodeRows(
      contextlessDirectRunRows(
        contextlessDirectRunPrompt,
        chatEventRowSchema.parse({
          ...contextlessDirectRunTerminal,
          chatThreadId: randomUUID(),
        }),
      ),
    );
    const reorderedDirectRunTerminalBody = encodeRows(
      contextlessDirectRunRows(
        contextlessDirectRunPrompt,
        chatEventRowSchema.parse({
          ...contextlessDirectRunTerminal,
          createdAt: contextlessDirectRunPrompt.createdAt,
        }),
      ),
    );
    const revokedDirectRunPromptBody = encodeRows(
      contextlessDirectRunRows(
        contextlessDirectRunPrompt,
        contextlessDirectRunTerminal,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          revokesEventId: contextlessDirectRunPrompt.id,
        }),
      ),
    );
    const duplicateDirectRunPromptBody = encodeRows(
      contextlessDirectRunRows(
        contextlessDirectRunPrompt,
        contextlessDirectRunTerminal,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          runId: contextlessDirectRunId,
          revokesEventId: null,
          eventType: "input.prompt",
          payload: { userMessage: contextlessDocument },
          contextType: "web",
          contextId: null,
          runEventSequenceNumber: null,
          runEventId: null,
        }),
      ),
    );
    const duplicateDirectRunTerminalBody = encodeRows(
      contextlessDirectRunRows(
        contextlessDirectRunPrompt,
        contextlessDirectRunTerminal,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          runId: contextlessDirectRunId,
          revokesEventId: null,
          eventType: "run.failed",
          payload: { error: "Sanitized second terminal." },
          contextType: null,
          contextId: null,
          runEventSequenceNumber: null,
          runEventId: null,
        }),
      ),
    );
    const duplicateDirectRunIdBody = encodeRows(
      originalRows.map((row) => {
        if (row.id === contextlessDirectRunPrompt.id) {
          return contextlessDirectRunPrompt;
        }
        if (row.id === contextlessDirectRunTerminal.id) {
          return contextlessDirectRunTerminal;
        }
        return row.id === semanticRootRow.id
          ? chatEventRowSchema.parse({
              ...semanticRootRow,
              id: contextlessDirectRunPrompt.id,
            })
          : row;
      }),
    );
    const missingDirectRunModelBody = encodeRows(
      contextlessDirectRunRows(
        chatEventRowSchema.parse({
          ...contextlessDirectRunPrompt,
          payload: { userMessage: contextlessDocument },
        }),
        contextlessDirectRunTerminal,
      ),
    );
    const malformedDirectRunModelBody = encodeRows(
      contextlessDirectRunRows(
        chatEventRowSchema.parse({
          ...contextlessDirectRunPrompt,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
                },
                ...contextlessDocument.parts,
              ],
            },
          },
        }),
        contextlessDirectRunTerminal,
      ),
    );
    const priorityDirectRunModelBody = encodeRows(
      contextlessDirectRunRows(
        chatEventRowSchema.parse({
          ...contextlessDirectRunPrompt,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
                  serviceTier: "priority",
                },
              ],
            },
          },
        }),
        contextlessDirectRunTerminal,
      ),
    );
    const futureDirectRunModelBody = encodeRows(
      contextlessDirectRunRows(
        chatEventRowSchema.parse({
          ...contextlessDirectRunPrompt,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                ...contextlessDocument.parts,
                {
                  type: "model",
                  selectedModel: HISTORICAL_MORNING_BRIEF_SELECTED_MODEL,
                  writerRevision: 2,
                },
              ],
            },
          },
        }),
        contextlessDirectRunTerminal,
      ),
    );
    const missingRetirementPredecessorBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessRetirement,
          revokesEventId: randomUUID(),
        }),
        contextlessRetirementCompanion,
      ),
    );
    const missingRetirementCompanionBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        contextlessRetirement,
        contextlessRetirementCompanionSource,
      ),
    );
    const mismatchedRetirementDocumentBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessRetirement,
          payload: {
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Sanitized mismatched cutover prompt.",
                },
              ],
            },
            error: RETIRED_MORNING_BRIEF_CUTOVER_ERROR,
          },
        }),
        contextlessRetirementCompanion,
      ),
    );
    const crossThreadRetirementBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessRetirement,
          chatThreadId: randomUUID(),
        }),
        contextlessRetirementCompanion,
      ),
    );
    const malformedRetirementCompanionBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        contextlessRetirement,
        chatEventRowSchema.parse({
          ...contextlessRetirementCompanion,
          runEventSequenceNumber: 1,
        }),
      ),
    );
    const futureRetirementBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        chatEventRowSchema.parse({
          ...contextlessRetirement,
          runEventId: "legacy-cutover:future",
        }),
        contextlessRetirementCompanion,
      ),
    );
    const ambiguousRetirementBody = encodeRows(
      contextlessRetirementRows(
        contextlessRoot,
        contextlessRetirement,
        contextlessRetirementCompanion,
        chatEventRowSchema.parse({
          ...semanticRootRow,
          revokesEventId: contextlessRoot.id,
        }),
      ),
    );
    const duplicateRetirementIdBody = encodeRows(
      originalRows.map((row) => {
        if (row.id === contextlessRoot.id) {
          return contextlessRoot;
        }
        if (row.id === contextlessRetirement.id) {
          return contextlessRetirement;
        }
        if (row.id === contextlessRetirementCompanion.id) {
          return contextlessRetirementCompanion;
        }
        return row.id === semanticRootRow.id
          ? chatEventRowSchema.parse({
              ...semanticRootRow,
              id: contextlessRoot.id,
            })
          : row;
      }),
    );
    const reorderedRetirementRoot = chatEventRowSchema.parse({
      ...semanticRootRow,
      runId: null,
      revokesEventId: null,
      eventType: "input.prompt",
      payload: { userMessage: contextlessDocument },
      contextType: "morning_brief",
      contextId: null,
      runEventSequenceNumber: null,
      runEventId: null,
    });
    const reorderedRetirement = chatEventRowSchema.parse({
      ...contextlessRetirement,
      revokesEventId: reorderedRetirementRoot.id,
    });
    const reorderedRetirementRows = originalRows.map((row): ChatEventRow => {
      if (row.id === reorderedRetirement.id) {
        return reorderedRetirement;
      }
      if (row.id === contextlessRetirementCompanion.id) {
        return contextlessRetirementCompanion;
      }
      if (row.id === reorderedRetirementRoot.id) {
        return reorderedRetirementRoot;
      }
      return row.id === semanticTerminalRow.id
        ? chatEventRowSchema.parse({
            ...semanticTerminalRow,
            revokesEventId: randomUUID(),
          })
        : row;
    });
    expect(
      reorderedRetirementRows.every((row, index) => {
        const prior = reorderedRetirementRows[index - 1];
        return prior === undefined || row.seqId > prior.seqId;
      }),
    ).toBeTruthy();
    const reorderedRetirementBody = encodeRows(reorderedRetirementRows);
    const unresolvedRevokeBody = encodeRows(
      originalRows.map((row) => {
        return row.id === rejectedRow.id
          ? {
              ...row,
              eventType: "control.revoke",
              runId: null,
              revokesEventId: randomUUID(),
              contextType: "morning_brief",
              contextId: inputRow.id,
              payload: null,
              runEventSequenceNumber: null,
              runEventId: null,
            }
          : row;
      }),
    );
    const semanticReorderRows = originalRows.map((row): ChatEventRow => {
      if (row.id === rejectedRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          runId: null,
          revokesEventId: semanticRootRow.id,
          eventType: "input.rejected",
          contextType: "morning_brief",
          contextId: semanticRootRow.id,
          runEventSequenceNumber: 0,
          runEventId: null,
        });
      }
      if (row.id === semanticRootRow.id) {
        return chatEventRowSchema.parse({
          ...row,
          runId: null,
          revokesEventId: null,
          eventType: "input.prompt",
          contextType: "morning_brief",
          contextId: row.id,
          runEventSequenceNumber: null,
          runEventId: null,
        });
      }
      return row.id === semanticTerminalRow.id
        ? chatEventRowSchema.parse({
            ...row,
            runId: null,
            revokesEventId: rejectedRow.id,
            eventType: "control.revoke",
            payload: null,
            contextType: "morning_brief",
            contextId: semanticRootRow.id,
            runEventSequenceNumber: null,
            runEventId: null,
          })
        : row;
    });
    expect(
      semanticReorderRows.every((row, index) => {
        const prior = semanticReorderRows[index - 1];
        return prior === undefined || row.seqId > prior.seqId;
      }),
    ).toBeTruthy();
    const semanticReorderBody = encodeRows(semanticReorderRows);
    const prefixBody = encodeRows(
      originalRows.map((row) => {
        return row.id === firstRow.id
          ? { ...row, chatThreadId: randomUUID() }
          : row;
      }),
    );
    const terminalBody = encodeRows(originalRows.slice(0, -1));
    const invalidGzip = Buffer.from("sanitized invalid gzip fixture");
    const cases = [
      {
        failureClass: "checksum",
        object: originalObject,
        keyDigest: createHash("sha256")
          .update("different sanitized checksum fixture")
          .digest("hex"),
      },
      {
        failureClass: "gzip",
        object: invalidGzip,
        keyDigest: createHash("sha256").update(invalidGzip).digest("hex"),
      },
      {
        failureClass: "raw_row",
        object: gzipSync(rawRowBody),
      },
      {
        failureClass: "projection",
        object: gzipSync(projectionBody),
        projectionSubstage: "current_contract",
        projectionVariant: "invalid_event_shape",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingPredecessorBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(mismatchedDocumentBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(unownedClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(invalidClaimOrderBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(multipleRevokersBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateContextlessIdBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingModelClaimPredecessorBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(mismatchedModelClaimPayloadBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(reorderedModelClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(crossThreadModelClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(malformedModelClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(ambiguousModelClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateModelClaimIdBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(futureModelClaimBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingDirectRunTerminalBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(crossThreadDirectRunTerminalBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(reorderedDirectRunTerminalBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(revokedDirectRunPromptBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateDirectRunPromptBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateDirectRunTerminalBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateDirectRunIdBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingDirectRunModelBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(malformedDirectRunModelBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(priorityDirectRunModelBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(futureDirectRunModelBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingRetirementPredecessorBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(missingRetirementCompanionBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(mismatchedRetirementDocumentBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(crossThreadRetirementBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(malformedRetirementCompanionBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(futureRetirementBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(ambiguousRetirementBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(duplicateRetirementIdBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(reorderedRetirementBody),
        projectionSubstage: "retired_context",
        projectionVariant: "missing_context_id",
      },
      {
        failureClass: "projection",
        object: gzipSync(unresolvedRevokeBody),
        projectionSubstage: "retired_event",
        projectionVariant: "unresolved_revoke_chain",
      },
      {
        failureClass: "projection",
        object: gzipSync(semanticReorderBody),
        projectionSubstage: "retired_event",
        projectionVariant: "unresolved_revoke_chain",
      },
      {
        failureClass: "prefix",
        object: gzipSync(prefixBody),
      },
      {
        failureClass: "terminal",
        object: gzipSync(terminalBody),
      },
    ] as const;

    for (const testCase of cases) {
      const digest =
        "keyDigest" in testCase
          ? testCase.keyDigest
          : createHash("sha256").update(testCase.object).digest("hex");
      const objectKey = `chat-events/${threadId}/${originalHead.last_seq_id.toString()}-${digest}.ndjson.gz`;
      writeFakeChatEventObject(objectKey, testCase.object);
      await trackFakeChatEventObject(Promise.resolve(objectKey));
      await updateChatEventSnapshotHead(context, threadId, objectKey);
      const staleHead = await readChatEventSnapshotHead(context, threadId);
      context.mocks.axiomLogging.warn.mockClear();

      await expect(
        eventsClient().snapshot({
          headers: authenticate(owner),
          params: { threadId },
        }),
      ).rejects.toThrow("Unknown response status 500");
      await expect(
        readChatEventSnapshotHead(context, threadId),
      ).resolves.toStrictEqual(staleHead);
      expect(readFakeChatEventObject(objectKey)).toStrictEqual(testCase.object);

      const skipLog = context.mocks.axiomLogging.warn.mock.calls.find(
        ([message, fields]) => {
          return (
            message === "Skipped Chat Event Snapshot pointer" &&
            (fields as Record<string, unknown> | undefined)?.type ===
              "chat_event_snapshot_head_skipped"
          );
        },
      );
      const fields = skipLog?.[1];
      if (typeof fields !== "object" || fields === null) {
        throw new Error("Expected a bounded Snapshot decode failure log");
      }
      expect(fields).toMatchObject({
        type: "chat_event_snapshot_head_skipped",
        chatThreadId: threadId,
        reason: "undecodable",
        failureClass: testCase.failureClass,
        context: "api:cron:snapshot-chat-events",
        ...("projectionSubstage" in testCase
          ? {
              projectionSubstage: testCase.projectionSubstage,
              projectionVariant: testCase.projectionVariant,
            }
          : {}),
      });
      expect(Object.keys(fields).sort()).toStrictEqual(
        [
          "chatThreadId",
          "context",
          "failureClass",
          "reason",
          "type",
          ...("projectionSubstage" in testCase
            ? ["projectionSubstage", "projectionVariant"]
            : []),
        ].sort(),
      );
    }
  }, 90_000);

  it("applies the same schema-version errors to Snapshot and Raw Event reads", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Schema negotiation agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `schema-negotiation-${randomUUID()}`,
    });
    const { authorization } = authenticate(owner);
    const rawRequest = setupRawAppRequest({
      context,
      routes: chatThreadRoutes,
    });
    const missingVersionPaths = [
      `/api/chat-threads/${threadId}/event-snapshot`,
      `/api/chat-threads/${threadId}/event-rows?sinceSeqId=0`,
    ];
    for (const path of missingVersionPaths) {
      const response = await rawRequest(path, {
        method: "GET",
        headers: { authorization },
      });
      expect(response).toStrictEqual({
        status: 400,
        body: {
          error: {
            message: "Invalid Chat Event schema version",
            code: "CHAT_EVENT_SCHEMA_VERSION_INVALID",
          },
        },
      });
    }
    const request = async (endpoint: "snapshot" | "rows", version: string) => {
      const headers = {
        ...authenticate(owner),
        [CHAT_EVENT_SCHEMA_VERSION_HEADER]: version,
      };
      return endpoint === "snapshot"
        ? await eventsClient().snapshot({ headers, params: { threadId } })
        : await eventsClient().rows({
            headers,
            params: { threadId },
            query: { sinceSeqId: 0 },
          });
    };
    const cases = [
      {
        version: "invalid",
        status: 400,
        message: "Invalid Chat Event schema version",
        code: "CHAT_EVENT_SCHEMA_VERSION_INVALID",
      },
      {
        version: (CURRENT_CHAT_EVENT_SCHEMA_VERSION - 1).toString(),
        status: 426,
        message: "The requested Chat Event schema version is retired",
        code: "CHAT_EVENT_SCHEMA_VERSION_RETIRED",
      },
      {
        version: (CURRENT_CHAT_EVENT_SCHEMA_VERSION + 1).toString(),
        status: 409,
        message:
          "The requested Chat Event schema version is newer than this API",
        code: "CHAT_EVENT_SCHEMA_VERSION_AHEAD",
      },
    ] as const;

    for (const endpoint of ["snapshot", "rows"] as const) {
      for (const testCase of cases) {
        const response = await request(endpoint, testCase.version);
        expect(response.status).toBe(testCase.status);
        expect(response.body).toStrictEqual({
          error: { message: testCase.message, code: testCase.code },
        });
      }
    }
  }, 60_000);

  it("serves current Raw Event rows from cold-start and paired cursors", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Row parity agent",
    });
    const marker = `row-parity-${randomUUID()}`;
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `${marker} first` },
          {
            type: "feedback",
            quote: "Raw feedback quote",
            note: [{ type: "text", text: "Keep the Raw Event location." }],
            eventId: "raw-feedback-source-event",
            range: { start: 2, end: 8 },
          },
        ],
      },
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} second`,
    });

    const fromStart = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    expect(fromStart.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    const firstRow = fromStart.body.rows[0];
    if (firstRow === undefined) {
      throw new Error("Expected seeded chat events");
    }
    const firstSeqId = firstRow.seqId;

    const canonicalInput = fromStart.body.rows
      .map((row) => {
        return chatEventFromRow(row);
      })
      .find((event) => {
        return event.eventType === "input.prompt";
      });
    if (canonicalInput?.eventType !== "input.prompt") {
      throw new Error("Expected the canonical feedback input");
    }
    expect(
      canonicalInput.userMessage.parts.find((part) => {
        return part.type === "feedback";
      }),
    ).toMatchObject({
      type: "feedback",
      eventId: "raw-feedback-source-event",
      range: { start: 2, end: 8 },
    });

    const rows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: firstRow.id,
        },
      }),
      [200],
    );
    expect(rows.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
      CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
    );
    expect(rows.body.cursor).toStrictEqual({
      lastEventId: rows.body.rows.at(-1)?.id,
      lastSeqId: rows.body.rows.at(-1)?.seqId,
    });
    for (const row of rows.body.rows) {
      chatEventRowSchema.parse(row);
      expect(row.chatThreadId).toBe(threadId);
      expect(row).not.toHaveProperty("content");
      expect(row).not.toHaveProperty("userMessage");
      expect(row).not.toHaveProperty("usagePayload");
      expect(row).not.toHaveProperty("interruptsRunId");
      expect(row).not.toHaveProperty("runGroupId");
    }

    const projected = rows.body.rows.map((row) => {
      return chatEventFromRow(row);
    });
    expect(projected).toHaveLength(rows.body.rows.length);
    expect(rows.body.rows).toStrictEqual(
      fromStart.body.rows.filter((row) => {
        return row.seqId > firstSeqId;
      }),
    );
    expect(projected).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: `${marker} second`,
              }),
            ]),
          }),
        }),
      ]),
    );

    expect(fromStart.body.rows[0]?.seqId).toBe(firstSeqId);
    expect(fromStart.body.rows).toHaveLength(rows.body.rows.length + 1);

    const mismatchedPair = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(mismatchedPair.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });

    const expired = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: 999_999,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });
  }, 60_000);

  it("garbage-collects unreferenced snapshot objects", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Snapshot maintenance agent",
    });
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `snapshot-maintenance-${randomUUID()}`,
    });

    await projectChatEventSearch(threadId);
    await runSnapshotCron([threadId]);

    const head = await readChatEventSnapshotHead(context, threadId);
    expect(readFakeChatEventObject(head.object_key)).toBeDefined();

    const future = mockR2GcWindowForKey(
      head.object_key,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );
    ageFakeChatEventObject(
      head.object_key,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const protectedHead = await runSnapshotCron([threadId], [head.object_key]);
    expect(protectedHead.r2ObjectsDeleted).toBe(0);
    expect(readFakeChatEventObject(head.object_key)).toBeDefined();

    const orphanKey = `chat-events/${threadId.slice(0, 3)}-orphan.ndjson.gz`;
    writeFakeChatEventObject(orphanKey, Buffer.from("orphan"));
    await trackFakeChatEventObject(Promise.resolve(orphanKey));
    ageFakeChatEventObject(
      orphanKey,
      new Date(future.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    const orphanGc = await runSnapshotCron([threadId], [orphanKey]);
    expect(orphanGc).toMatchObject({
      r2ObjectsMeasured: 1,
      r2ObjectsDeleted: 1,
    });
    expect(readFakeChatEventObject(orphanKey)).toBeUndefined();

    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `snapshot-replacement-${randomUUID()}`,
    });
    await projectChatEventSearch(threadId);
    const replacement = await runSnapshotCron([threadId], [head.object_key]);
    expect(replacement.r2ObjectsDeleted).toBe(1);
    expect(readFakeChatEventObject(head.object_key)).toBeUndefined();
    const newHead = await readChatEventSnapshotHead(context, threadId);
    expect(newHead.object_key).not.toBe(head.object_key);
    expect(readFakeChatEventObject(newHead.object_key)).toBeDefined();
  }, 120_000);

  it("limits object cleanup to the fixed per-pass quota", async () => {
    const shard = "ffe";
    const marker = randomUUID();
    const keys = Array.from({ length: 1001 }, (_, index) => {
      const subpartition = (index % 16).toString(16);
      return `chat-events/${shard}${subpartition}-quota-${marker}-${index.toString().padStart(4, "0")}.ndjson.gz`;
    });
    for (const key of keys) {
      writeFakeChatEventObject(key, Buffer.from("orphan"));
      await trackFakeChatEventObject(Promise.resolve(key));
    }
    mockR2GcWindowForKey(
      `chat-events/${shard}`,
      new Date(now() + 8 * 24 * 60 * 60 * 1000),
    );

    const result = await runSnapshotCron([], keys);

    expect(result.r2ObjectsDeleted).toBe(1000);
    const remaining = keys.filter((key) => {
      return readFakeChatEventObject(key) !== undefined;
    });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
