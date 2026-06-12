import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  createChatFilesBddApi,
  hostedTextFile,
  persistedAttachment,
  storageTextFile,
} from "./helpers/api-bdd-chat-files";
import { mockMemoryContent } from "./helpers/zero-memory";

/*
helper gap:
- CHAT-02 signed assistant callback, integration-message, and event-consumer
  ingestion still need a visible API helper that creates a run and exposes the
  callback signing material without reading agent_run_callbacks.
- CHAT-03 memory updates still need a visible run or callback journey that
  publishes memory versions without direct fixture writes; non-empty run
  artifacts and Google Drive status now live in chat-threads.bdd.test.ts.
- FILE-01 legacy /f/:userId/:id/:filename and raw hosted-content download do
  not have exported ts-rest contracts; this file covers typed upload, storage,
  and host APIs instead of using DB or untyped route fallbacks.
- CHAIN-CHAT callback-signing branches are blocked by the CHAT-02 callback
  signing gap; the run-to-artifact path is covered through public run and
  sandbox upload APIs in chat-threads.bdd.test.ts.
*/

const context = testContext();
const bdd = createBddApi(context);
const api = createChatFilesBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);
const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

describe("CHAT-01 chat thread lifecycle", () => {
  it("creates, mutates, lists, searches, and deletes a thread through visible APIs", async () => {
    const actor = bdd.user();
    const compose = await api.createComposeForChatThread(actor);
    const created = await api.createThread(actor, {
      agentId: compose.composeId,
      title: "Launch notes",
    });

    expect(created.title).toBe("Launch notes");

    let detail = await api.readThread(actor, created.id);
    expect(detail).toMatchObject({
      id: created.id,
      title: "Launch notes",
      agentId: compose.composeId,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
    });

    await api.patchThread(actor, created.id, {
      draftContent: "follow up on the launch",
      draftAttachments: [
        persistedAttachment(
          randomUUID(),
          "brief.txt",
          "text/plain",
          "follow up on the launch".length,
        ),
      ],
    });
    detail = await api.readThread(actor, created.id);
    expect(detail.draftContent).toBe("follow up on the launch");
    expect(detail.draftAttachments).toHaveLength(1);

    await api.renameThread(actor, created.id, "Renamed launch notes");
    detail = await api.readThread(actor, created.id);
    expect(detail.title).toBe("Renamed launch notes");
    expect(detail.renamedAt).toStrictEqual(expect.any(String));

    await api.pinThread(actor, created.id);
    await api.unpinThread(actor, created.id);

    const markedRead = await api.markThreadRead(actor, created.id);
    expect(markedRead).toStrictEqual({
      lastReadMessageId: null,
      lastReadAt: expect.any(String),
      changed: false,
    });

    await api.updateThreadModelSelection(actor, created.id, null);
    detail = await api.readThread(actor, created.id);
    expect(detail.selectedModel).toBeNull();

    const messages = await api.listThreadMessages(actor, created.id);
    expect(messages.messages).toStrictEqual([]);

    const artifacts = await api.listThreadArtifacts(actor, created.id);
    expect(artifacts.runs).toStrictEqual([]);

    const search = await api.searchChat(actor, "launch");
    expect(search.results).toStrictEqual([]);
    expect(search.hasMore).toBeFalsy();

    await api.deleteThread(actor, created.id);
    const deletedRead = await api.requestReadThread(actor, created.id, [404]);
    expectApiError(deletedRead.body);
    expect(deletedRead.body.error.code).toBe("NOT_FOUND");
  });

  it("hides owned threads from peer users and other organizations", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const outsider = bdd.user();
    const compose = await api.createComposeForChatThread(owner);
    const thread = await api.createThread(owner, {
      agentId: compose.composeId,
      title: "Private planning",
    });

    await expect(api.readThread(owner, thread.id)).resolves.toMatchObject({
      id: thread.id,
    });

    const peerRead = await api.requestReadThread(peer, thread.id, [404]);
    expectApiError(peerRead.body);
    expect(peerRead.body.error.code).toBe("NOT_FOUND");

    const outsiderRead = await api.requestReadThread(
      outsider,
      thread.id,
      [404],
    );
    expectApiError(outsiderRead.body);
    expect(outsiderRead.body.error.code).toBe("NOT_FOUND");

    const peerList = await api.listThreads(peer);
    expect(
      [...peerList.pinned, ...peerList.threads].some((item) => {
        return item.id === thread.id;
      }),
    ).toBeFalsy();
  });

  it("given an owned thread, when mutation routes are chained, then only owner-visible state changes", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const agent = await bdd.createAgent(owner, {
      displayName: "Pinned launch plan agent",
    });
    const thread = await api.createThread(owner, {
      agentId: agent.agentId,
      title: "Owner launch plan",
    });

    await api.renameThread(owner, thread.id, "Pinned launch plan");
    await api.updateThreadModelSelection(owner, thread.id, {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: "gpt-5.4-mini",
    });
    await api.pinThread(owner, thread.id);
    const readEmpty = await api.markThreadRead(owner, thread.id);

    expect(readEmpty).toStrictEqual({
      lastReadMessageId: null,
      lastReadAt: expect.any(String),
      changed: false,
    });

    const pinnedList = await api.listThreads(owner, {
      agentId: agent.agentId,
    });
    expect(pinnedList.pinned).toHaveLength(1);
    expect(pinnedList.pinned[0]).toMatchObject({
      id: thread.id,
      title: "Pinned launch plan",
      pinnedAt: expect.any(String),
      renamedAt: expect.any(String),
    });
    expect(pinnedList.threads).toStrictEqual([]);
    expect(pinnedList.totalCount).toBe(0);

    let detail = await api.readThread(owner, thread.id);
    expect(detail.selectedModel).toBe("gpt-5.4-mini");
    expect(detail.lastReadMessageId ?? null).toBeNull();

    const peerRename = await api.requestRenameThread(
      peer,
      thread.id,
      "Peer rewrite",
      [404],
    );
    expectApiError(peerRename.body);
    expect(peerRename.body.error.code).toBe("NOT_FOUND");

    const peerModelSelection = await api.requestUpdateThreadModelSelection(
      peer,
      thread.id,
      null,
      [404],
    );
    expectApiError(peerModelSelection.body);
    expect(peerModelSelection.body.error.code).toBe("NOT_FOUND");

    const peerUnpin = await api.requestUnpinThread(peer, thread.id, [404]);
    expectApiError(peerUnpin.body);
    expect(peerUnpin.body.error.code).toBe("NOT_FOUND");

    const peerPin = await api.requestPinThread(peer, thread.id, [404]);
    expectApiError(peerPin.body);
    expect(peerPin.body.error.code).toBe("NOT_FOUND");

    const peerMarkRead = await api.requestMarkThreadRead(
      peer,
      thread.id,
      [404],
    );
    expectApiError(peerMarkRead.body);
    expect(peerMarkRead.body.error.code).toBe("NOT_FOUND");

    detail = await api.readThread(owner, thread.id);
    expect(detail.title).toBe("Pinned launch plan");
    expect(detail.selectedModel).toBe("gpt-5.4-mini");

    await api.unpinThread(owner, thread.id);
    await api.updateThreadModelSelection(owner, thread.id, null);

    const unpinnedList = await api.listThreads(owner, {
      agentId: agent.agentId,
    });
    expect(unpinnedList.pinned).toStrictEqual([]);
    expect(unpinnedList.threads).toHaveLength(1);
    expect(unpinnedList.threads[0]).toMatchObject({
      id: thread.id,
      title: "Pinned launch plan",
      pinnedAt: null,
    });
    expect(unpinnedList.totalCount).toBe(1);

    detail = await api.readThread(owner, thread.id);
    expect(detail.selectedModel).toBeNull();
  });
});

describe("CHAT-02 chat messages and visible validation", () => {
  it("sends chat messages through API-visible no-credit, recall, and interrupt branches", async () => {
    const actor = bdd.user();
    const peer = bdd.user({ orgId: actor.orgId });
    const agent = await bdd.createAgent(actor, {
      displayName: "No-credit chat branch agent",
    });
    const uploadId = randomUUID();
    const clientMessageId = randomUUID();

    const sent = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Build a launch-plan presentation",
        attachFiles: [
          {
            id: uploadId,
            filename: "launch-plan.txt",
            contentType: "text/plain",
            size: 24,
          },
        ],
        hasTextContent: false,
        clientMessageId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error(
        "Expected chat send to create visible no-credit messages",
      );
    }
    expect(sent.body.runId).toBeNull();
    expect(sent.body.threadId).toStrictEqual(expect.any(String));

    const threadId = sent.body.threadId;
    const detail = await api.readThread(actor, threadId);
    expect(detail).toMatchObject({
      id: threadId,
      agentId: agent.agentId,
      draftContent: null,
      draftAttachments: null,
    });

    const messages = await api.listThreadMessages(actor, threadId);
    expect(messages.messages).toHaveLength(2);

    const userMessage = messages.messages.find((message) => {
      return message.role === "user";
    });
    const assistantMessage = messages.messages.find((message) => {
      return message.role === "assistant";
    });

    expect(userMessage).toMatchObject({
      role: "user",
      content: "Build a launch-plan presentation",
      error: "insufficient_credits",
      attachFiles: [
        {
          id: uploadId,
          filename: "launch-plan.txt",
          contentType: "text/plain",
          size: 24,
        },
      ],
    });
    expect(assistantMessage?.content).toContain("Insufficient credits");
    expect(assistantMessage?.error).toBe("insufficient_credits");

    const retried = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        prompt: "Retry the same client message",
        clientMessageId,
      },
      [201],
    );
    expect(retried.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });

    const afterRetry = await api.listThreadMessages(actor, threadId);
    expect(afterRetry.messages).toHaveLength(2);

    const secondThread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Duplicate client message id",
    });
    const duplicateAcrossThreads = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId: secondThread.id,
        prompt: "Reuse the client message id in another thread",
        clientMessageId,
      },
      [409],
    );
    expectApiError(duplicateAcrossThreads.body);
    expect(duplicateAcrossThreads.body.error.code).toBe("CONFLICT");
    expect(duplicateAcrossThreads.body.error.message).toBe(
      "clientMessageId is already in use",
    );

    if (!userMessage) {
      throw new Error("Expected the no-credit send to create a user message");
    }

    const unavailableFollowup = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        prompt: "Use a stale recommended follow-up",
        revokesMessageId: userMessage.id,
      },
      [400],
    );
    expectApiError(unavailableFollowup.body);
    expect(unavailableFollowup.body.error.code).toBe("BAD_REQUEST");
    expect(unavailableFollowup.body.error.message).toBe(
      "Recommended follow-up is no longer available",
    );

    const peerRecall = await api.requestSendMessage(
      peer,
      {
        agentId: agent.agentId,
        threadId,
        revokesMessageId: userMessage.id,
      },
      [404],
    );
    expectApiError(peerRecall.body);
    expect(peerRecall.body.error.code).toBe("NOT_FOUND");

    const recalled = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        revokesMessageId: userMessage.id,
        clientMessageId: randomUUID(),
      },
      [201],
    );
    if (recalled.status !== 201) {
      throw new Error("Expected chat recall to create a visible message");
    }
    expect(recalled.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });

    const afterRecall = await api.listThreadMessages(actor, threadId);
    expect(
      afterRecall.messages.some((message) => {
        return message.revokesMessageId === userMessage.id;
      }),
    ).toBeTruthy();

    const repeatedRecall = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        revokesMessageId: userMessage.id,
      },
      [201],
    );
    expect(repeatedRecall.body).toMatchObject({
      runId: null,
      threadId,
      createdAt: expect.any(String),
    });
    const afterRepeatedRecall = await api.listThreadMessages(actor, threadId);
    expect(
      afterRepeatedRecall.messages.filter((message) => {
        return message.revokesMessageId === userMessage.id;
      }),
    ).toHaveLength(1);

    const interrupted = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        threadId,
        interruptsRunId: randomUUID(),
      },
      [400],
    );
    expectApiError(interrupted.body);
    expect(interrupted.body.error.code).toBe("BAD_REQUEST");
    expect(interrupted.body.error.message).toBe(
      "Only active chat runs can be interrupted",
    );
  });

  it("rejects invalid generation template and reused client thread ids through the send API", async () => {
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "Client-thread retry branch agent",
    });

    const invalidTemplate = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Use an unknown template",
        generationTemplate: {
          type: "presentation",
          selection: {
            designSystemId: "missing-design-system",
            templateId: "missing-template",
          },
        },
      },
      [400],
    );
    expectApiError(invalidTemplate.body);
    expect(invalidTemplate.body.error.code).toBe("BAD_REQUEST");
    expect(invalidTemplate.body.error.message).toBe(
      "Unknown generation template",
    );

    const clientThreadId = randomUUID();
    const first = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "First client-thread send",
        clientThreadId,
      },
      [201],
    );
    if (first.status !== 201) {
      throw new Error("Expected first client-thread send to create the thread");
    }
    expect(first.body.threadId).toBe(clientThreadId);

    const retry = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Retry without an associated run",
        clientThreadId,
      },
      [400],
    );
    expectApiError(retry.body);
    expect(retry.body.error.code).toBe("BAD_REQUEST");
    expect(retry.body.error.message).toBe("Client thread id is already in use");

    const otherAgent = await bdd.createAgent(actor, {
      displayName: "Client-thread mismatch branch agent",
    });
    const reusedClientThreadForOtherAgent = await api.requestSendMessage(
      actor,
      {
        agentId: otherAgent.agentId,
        prompt: "Reuse a client thread id for another agent",
        clientThreadId,
      },
      [404],
    );
    expectApiError(reusedClientThreadForOtherAgent.body);
    expect(reusedClientThreadForOtherAgent.body.error.code).toBe("NOT_FOUND");

    const peer = bdd.user({ orgId: actor.orgId });
    const ownerThread = await api.createThread(actor, {
      agentId: agent.agentId,
      title: "Owner-only send target",
    });
    const peerSendToOwnerThread = await api.requestSendMessage(
      peer,
      {
        agentId: agent.agentId,
        threadId: ownerThread.id,
        prompt: "Post into another user's thread",
      },
      [404],
    );
    expectApiError(peerSendToOwnerThread.body);
    expect(peerSendToOwnerThread.body.error.code).toBe("NOT_FOUND");

    const modelSelected = await api.requestSendMessage(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Persist the model selected at send time",
        modelSelection: {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: "gpt-5.4-mini",
        },
      },
      [201],
    );
    if (modelSelected.status !== 201) {
      throw new Error("Expected model-selected chat send to create a thread");
    }
    const modelSelectedThread = await api.readThread(
      actor,
      modelSelected.body.threadId,
    );
    expect(modelSelectedThread.selectedModel).toBe("gpt-5.4-mini");
  });

  it("lists visible messages and rejects invalid send requests without hidden fixtures", async () => {
    const actor = bdd.user();
    const peer = bdd.user({ orgId: actor.orgId });
    const compose = await api.createComposeForChatThread(actor);
    const thread = await api.createThread(actor, {
      agentId: compose.composeId,
      title: "Message validation",
    });

    const initialMessages = await api.listThreadMessages(actor, thread.id);
    expect(initialMessages.messages).toStrictEqual([]);

    const unauthenticated = await api.requestSendMessage(
      null,
      { agentId: randomUUID(), prompt: "hello" },
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingAgent = await api.requestSendMessage(
      actor,
      { agentId: randomUUID(), prompt: "hello" },
      [404],
    );
    expectApiError(missingAgent.body);
    expect(missingAgent.body.error.code).toBe("NOT_FOUND");

    const blankPrompt = await api.requestSendMessage(
      actor,
      { agentId: randomUUID(), prompt: "" },
      [400],
    );
    expectApiError(blankPrompt.body);
    expect(blankPrompt.body.error.code).toBe("BAD_REQUEST");

    const privateAgent = await bdd.createAgent(actor, {
      displayName: "Private chat send agent",
      visibility: "private",
    });
    const forbiddenPrivateAgent = await api.requestSendMessage(
      peer,
      {
        agentId: privateAgent.agentId,
        prompt: "Run someone else's private agent",
      },
      [403],
    );
    expectApiError(forbiddenPrivateAgent.body);
    expect(forbiddenPrivateAgent.body.error.code).toBe("FORBIDDEN");
    expect(forbiddenPrivateAgent.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  });

  it("given an empty chat thread, when message list boundaries are requested, then only the owner sees zero messages", async () => {
    const orgId = `org_${randomUUID()}`;
    const owner = bdd.user({ orgId });
    const peer = bdd.user({ orgId });
    const compose = await api.createComposeForChatThread(owner);
    const thread = await api.createThread(owner, {
      agentId: compose.composeId,
      title: "Zero message boundary",
    });

    const ownerMessages = await api.listThreadMessages(owner, thread.id, {
      limit: 1,
    });
    expect(ownerMessages).toStrictEqual({
      messages: [],
      hasHistoryBefore: false,
    });

    const peerMessages = await api.requestListThreadMessages(
      peer,
      thread.id,
      { limit: 1 },
      [404],
    );
    expectApiError(peerMessages.body);
    expect(peerMessages.body.error.code).toBe("NOT_FOUND");

    const missingMessages = await api.requestListThreadMessages(
      owner,
      randomUUID(),
      {},
      [404],
    );
    expectApiError(missingMessages.body);
    expect(missingMessages.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CHAT-03 artifacts and memory", () => {
  it("exposes empty memory and artifact state through GET/list APIs", async () => {
    const actor = bdd.user();
    const compose = await api.createComposeForChatThread(actor);
    const thread = await api.createThread(actor, {
      agentId: compose.composeId,
      title: "Artifacts",
    });

    const artifacts = await api.listThreadArtifacts(actor, thread.id);
    expect(artifacts.runs).toStrictEqual([]);

    const missingArtifacts = await api.requestListThreadArtifacts(
      actor,
      randomUUID(),
      [404],
    );
    expectApiError(missingArtifacts.body);
    expect(missingArtifacts.body.error.code).toBe("NOT_FOUND");

    const memory = await api.readMemory(actor);
    expect(memory).toMatchObject({
      exists: false,
      fileCount: 0,
      files: [],
      fileContents: [],
      updatedAt: null,
    });

    const activity = await api.readMemoryActivity(actor);
    expect(activity.entries).toStrictEqual([]);
    expect(activity.nextCursor).toBeNull();
  });

  it("rejects memory reads without an authenticated org context", async () => {
    const unauthenticated = await api.requestReadMemory(null, [401]);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const noOrg = await api.requestReadMemory(bdd.user({ orgId: null }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("publishes a memory artifact through storage APIs and reads it back", async () => {
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/upload?sig=test",
    );
    api.mockObjectStorageObjectsExist();

    const missing = await api.readMemory(owner);
    expect(missing).toStrictEqual({
      exists: false,
      name: "memory",
      size: 0,
      fileCount: 0,
      updatedAt: null,
      files: [],
      fileContents: [],
    });

    const files = [
      storageTextFile("MEMORY.md", "# My Memory"),
      storageTextFile("notes/todo.md", "Do the thing"),
    ];
    const prepared = await api.prepareStorage(owner, {
      storageName: "memory",
      storageType: "artifact",
      files,
      force: true,
    });
    if (!prepared.uploads) {
      throw new Error("Expected memory prepare to return upload targets");
    }

    const uncommitted = await api.readMemory(owner);
    expect(uncommitted).toStrictEqual({
      exists: true,
      name: "memory",
      size: 0,
      fileCount: 0,
      updatedAt: expect.any(String),
      files: [],
      fileContents: [],
    });

    const s3Key = prepared.uploads.archive.key.replace(
      /\/archive\.tar\.gz$/,
      "",
    );
    mockMemoryContent(context, {
      s3Key,
      files: [
        { path: "./MEMORY.md", content: "# My Memory" },
        { path: "notes/todo.md", content: "Do the thing" },
      ],
    });

    const committed = await api.commitStorage(owner, {
      storageName: "memory",
      storageType: "artifact",
      versionId: prepared.versionId,
      files,
    });
    expect(committed).toMatchObject({ success: true, fileCount: 2 });

    const populated = await api.readMemory(owner);
    expect(populated).toStrictEqual({
      exists: true,
      name: "memory",
      size: 23,
      fileCount: 2,
      updatedAt: expect.any(String),
      files: [
        { path: "MEMORY.md", size: 11 },
        { path: "notes/todo.md", size: 12 },
      ],
      fileContents: [
        { path: "MEMORY.md", content: "# My Memory" },
        { path: "notes/todo.md", content: "Do the thing" },
      ],
    });

    const peerMemory = await api.readMemory(peer);
    expect(peerMemory.exists).toBeFalsy();

    authOrg.mockClerkOrg(owner);
    const key = await authOrg.createApiKey(owner, {
      name: "BDD memory token",
      expiresInDays: 7,
    });
    const bearerMemory = await api.readMemoryWithBearer(key.token, [200]);
    if (bearerMemory.status !== 200) {
      throw new Error("Expected the CLI bearer token to read memory");
    }
    expect(bearerMemory.body.exists).toBeTruthy();
    expect(bearerMemory.body.fileContents).toStrictEqual(
      expect.arrayContaining([{ path: "MEMORY.md", content: "# My Memory" }]),
    );
  });
});

describe("FILE-01 uploads, storage, and host APIs", () => {
  it("prepares and completes an upload through S3 boundary state", async () => {
    const actor = bdd.user();

    const prepared = await api.prepareUpload(actor, {
      filename: "notes.txt",
      contentType: "Text/Plain; Charset=UTF-8",
      size: 12,
    });
    expect(prepared).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
    });
    expect(prepared.uploadUrl).toMatch(/^https?:\/\//);
    expect(prepared.url).toContain(`/artifacts/${actor.userId}/`);

    api.mockCompletedUploadObject(actor, prepared.id, "notes.txt", 12);
    const completed = await api.completeUpload(actor, { id: prepared.id });
    expect(completed).toMatchObject({
      id: prepared.id,
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
    });

    const otherActor = bdd.user();
    const crossUserComplete = await api.requestCompleteUpload(
      otherActor,
      { id: prepared.id },
      [404],
    );
    expectApiError(crossUserComplete.body);
    expect(crossUserComplete.body.error.code).toBe("NOT_FOUND");

    const unsupported = await api.requestPrepareUpload(
      actor,
      {
        filename: "malware.exe",
        contentType: "application/x-msdownload",
        size: 10,
      },
      [400],
    );
    expectApiError(unsupported.body);
    expect(unsupported.body.error.message).toContain("Unsupported file type");
  });

  it("chains storage prepare, commit, list, and download APIs", async () => {
    const actor = bdd.user();
    const storageName = `bdd-artifact-${randomUUID().slice(0, 8)}`;
    const storageFile = storageTextFile(
      "/notes.txt",
      "visible storage content",
    );
    const files = [storageFile];

    const prepared = await api.prepareStorage(actor, {
      storageName,
      storageType: "artifact",
      files,
      force: true,
    });
    expect(prepared.existing).toBeFalsy();
    expect(prepared.uploads?.archive.presignedUrl).toMatch(/^https?:\/\//);
    expect(prepared.uploads?.manifest.presignedUrl).toMatch(/^https?:\/\//);

    api.mockObjectStorageObjectsExist();
    const committed = await api.commitStorage(actor, {
      storageName,
      storageType: "artifact",
      versionId: prepared.versionId,
      files,
      message: "BDD artifact upload",
    });
    expect(committed).toMatchObject({
      success: true,
      storageName,
      versionId: prepared.versionId,
      size: storageFile.size,
      fileCount: 1,
    });

    const listed = await api.listStorages(actor, "artifact");
    expect(
      listed.some((item) => {
        return item.name === storageName && item.fileCount === 1;
      }),
    ).toBeTruthy();

    const download = await api.downloadStorage(actor, storageName, "artifact");
    expect(download).toMatchObject({
      versionId: prepared.versionId,
      fileCount: 1,
      size: storageFile.size,
    });
    expect("url" in download ? download.url : "").toMatch(/^https?:\/\//);

    const otherActor = bdd.user();
    const crossUserDownload = await api.requestDownloadStorage(
      otherActor,
      storageName,
      "artifact",
      [404],
    );
    expectApiError(crossUserDownload.body);
    expect(crossUserDownload.body.error.code).toBe("NOT_FOUND");
  });

  it("prepares and completes a hosted-site deployment through host APIs", async () => {
    const actor = bdd.user();
    const site = `bdd-site-${randomUUID().slice(0, 8)}`;

    const prepared = await api.prepareHostedSite(actor, {
      site,
      slugSuffix: "release-01",
      artifactKind: "hosted-site",
      spaFallback: true,
      files: [
        hostedTextFile("/index.html", "<main>BDD hosted site</main>"),
        hostedTextFile(
          "/assets/app.js",
          "console.log('bdd');",
          "application/javascript",
        ),
      ],
    });
    expect(prepared.publicSlug).toMatch(
      new RegExp(`^${site}-[a-f0-9]{8}-release-01$`),
    );
    expect(prepared.uploads).toHaveLength(2);

    const otherActor = bdd.user();
    const crossOrgComplete = await api.requestCompleteHostedSite(
      otherActor,
      prepared.deploymentId,
      [404],
    );
    expectApiError(crossOrgComplete.body);
    expect(crossOrgComplete.body.error.code).toBe("NOT_FOUND");

    api.mockObjectStorageObjectsExist();
    const completed = await api.completeHostedSite(
      actor,
      prepared.deploymentId,
    );
    expect(completed).toStrictEqual({
      siteId: prepared.siteId,
      deploymentId: prepared.deploymentId,
      publicSlug: prepared.publicSlug,
      url: prepared.url,
      status: "ready",
    });

    const invalid = await api.requestPrepareHostedSite(
      actor,
      {
        site: `bdd-invalid-${randomUUID().slice(0, 8)}`,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: [hostedTextFile("/about.html", "<main>missing index</main>")],
      },
      [400],
    );
    expectApiError(invalid.body);
    expect(invalid.body.error.message).toContain("must include /index.html");
  });
});
