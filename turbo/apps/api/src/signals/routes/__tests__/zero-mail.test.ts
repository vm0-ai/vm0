import { Buffer } from "node:buffer";

import { testMailDraftStateContract } from "@vm0/api-contracts/contracts/test-mail-draft-state";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { server } from "../../../mocks/server";
import { testMailDraftStateRoutes } from "../test-mail-draft-state";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createZeroRouteMocks(context);
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_DRAFT_ID = "r-test-draft";
const GMAIL_THREAD_ID = "gmail-thread-id";
const GMAIL_MESSAGE_ID = "gmail-draft-message-id";
const GMAIL_SENT_MESSAGE_ID = "gmail-sent-message-id";

interface GmailDraftTestState {
  exists: boolean;
  raw: string;
  sendCount: number;
  deleteCount: number;
}

function mockGmailDraftApi(): GmailDraftTestState {
  const state: GmailDraftTestState = {
    exists: true,
    raw: "",
    sendCount: 0,
    deleteCount: 0,
  };
  server.use(
    http.post(`${GMAIL_API_BASE}/drafts`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer gmail-mail-card-token",
      );
      const body = (await request.json()) as {
        message: { raw: string; threadId?: string };
      };
      state.raw = body.message.raw;
      state.exists = true;
      return HttpResponse.json({
        id: GMAIL_DRAFT_ID,
        message: {
          id: GMAIL_MESSAGE_ID,
          threadId: body.message.threadId ?? GMAIL_THREAD_ID,
        },
      });
    }),
    http.get(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      if (!state.exists) {
        return new HttpResponse(null, { status: 404 });
      }
      return HttpResponse.json({
        id: GMAIL_DRAFT_ID,
        message: {
          id: GMAIL_MESSAGE_ID,
          threadId: GMAIL_THREAD_ID,
          raw: state.raw,
        },
      });
    }),
    http.put(
      `${GMAIL_API_BASE}/drafts/:draftId`,
      async ({ params, request }) => {
        expect(params.draftId).toBe(GMAIL_DRAFT_ID);
        const body = (await request.json()) as {
          message: { raw: string; threadId: string };
        };
        state.raw = body.message.raw;
        return HttpResponse.json({
          id: GMAIL_DRAFT_ID,
          message: {
            id: `${GMAIL_MESSAGE_ID}-updated`,
            threadId: body.message.threadId,
          },
        });
      },
    ),
    http.post(`${GMAIL_API_BASE}/drafts/send`, async ({ request }) => {
      const body = (await request.json()) as {
        id: string;
        message: { raw: string; threadId: string };
      };
      expect(body.id).toBe(GMAIL_DRAFT_ID);
      state.raw = body.message.raw;
      state.exists = false;
      state.sendCount += 1;
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: body.message.threadId,
      });
    }),
    http.get(`${GMAIL_API_BASE}/messages/:messageId`, ({ params }) => {
      expect(params.messageId).toBe(GMAIL_SENT_MESSAGE_ID);
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: GMAIL_THREAD_ID,
        raw: state.raw,
      });
    }),
    http.delete(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      state.exists = false;
      state.deleteCount += 1;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

async function seedGmailMailCardFixture() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const actorWithOrg = { ...actor, orgId: actor.orgId };
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Zero Mail agent",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Mail review",
  });
  mockGmailConnectorOAuth({
    accessToken: "gmail-mail-card-token",
    email: "sender@example.com",
  });
  const start = await connectors.startOauth(actor, "gmail", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  await connectors.completeOauthCallback("gmail", {
    code: "zero-mail-code",
    state,
  });
  await runs.enableAgentConnectors(actor, agent.agentId, ["gmail"]);
  await updateFeatureSwitchesForUser(context, actorWithOrg, {
    [FeatureSwitchKey.ZeroMail]: true,
  });
  mocks.clerk.session(actor.userId, actorWithOrg.orgId);
  return { actor, agent, thread };
}

function client() {
  return setupApp({ context })(zeroMailContract);
}

function stateClient() {
  return setupApp({ context, routes: testMailDraftStateRoutes })(
    testMailDraftStateContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/zero/mail/drafts", () => {
  it("creates, edits, reads, and sends a real Gmail draft", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();

    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["first@example.com"],
          cc: ["copy@example.com"],
          bcc: ["blind@example.com"],
          subject: "Initial subject",
          body: "Initial body",
          inReplyTo: "<original@example.com>",
          references: ["<first@example.com>", "<original@example.com>"],
          gmailThreadId: GMAIL_THREAD_ID,
        },
      }),
      [201],
    );
    expect(created.body.mailDraft).toMatchObject({
      provider: "gmail",
      from: "sender@example.com",
      status: "draft",
      gmailDraftId: GMAIL_DRAFT_ID,
      gmailThreadId: GMAIL_THREAD_ID,
      cc: ["copy@example.com"],
      bcc: ["blind@example.com"],
      inReplyTo: "<original@example.com>",
    });
    expect(created.body.mailDraftUrl).toBe(
      `http://localhost:3002/mail/drafts/${created.body.mailDraftId}`,
    );
    expect(Buffer.from(gmail.raw, "base64url").toString("utf8")).toContain(
      "References: <first@example.com> <original@example.com>",
    );

    const edited = await accept(
      client().updateDraft({
        headers: authHeaders(),
        params: {
          mailDraftId: created.body.mailDraftId,
        },
        body: {
          to: ["final@example.com"],
          cc: ["updated-copy@example.com"],
          bcc: [],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [200],
    );
    expect(edited.body.mailDraft).toMatchObject({
      to: ["final@example.com"],
      cc: ["updated-copy@example.com"],
      bcc: [],
      subject: "Updated subject",
      body: "Updated body",
      status: "draft",
    });

    const sent = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: {
          mailDraftId: created.body.mailDraftId,
        },
        body: {
          to: ["final@example.com"],
          cc: ["updated-copy@example.com"],
          bcc: [],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [200],
    );
    expect(sent.body.mailDraft.status).toBe("sent");
    expect(sent.body.mailDraft.sentGmailMessageId).toBe(GMAIL_SENT_MESSAGE_ID);
    expect(sent.body.mailDraft.sentAt).toBeDefined();
    expect(gmail.sendCount).toBe(1);
    const sentRaw = Buffer.from(gmail.raw, "base64url").toString("utf8");
    expect(sentRaw).toContain("To: final@example.com");
    expect(sentRaw).toContain("Cc: updated-copy@example.com");
    expect(sentRaw).toContain(
      Buffer.from("Updated body", "utf8").toString("base64"),
    );

    const duplicate = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: {
          mailDraftId: created.body.mailDraftId,
        },
        body: {
          to: ["final@example.com"],
          cc: ["updated-copy@example.com"],
          bcc: [],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain("can no longer be sent");
    expect(gmail.sendCount).toBe(1);

    const page = await chat.listThreadMessages(
      fixture.actor,
      fixture.thread.id,
    );
    const persisted = page.messages.find((message) => {
      return message.content === created.body.mailDraftUrl;
    });
    expect(persisted).toMatchObject({
      content: created.body.mailDraftUrl,
    });

    await connectors.deleteConnectorByType(fixture.actor, "gmail");

    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraft).toMatchObject({
      subject: "Updated subject",
      status: "sent",
      detailAvailable: false,
      from: "sender@example.com",
    });
  });

  it("marks a Gmail-missing row deleted and keeps its card summary", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["recipient@example.com"],
          subject: "Missing provider draft",
          body: "Disposable body",
        },
      }),
      [201],
    );
    gmail.exists = false;

    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraft).toMatchObject({
      subject: "Missing provider draft",
      status: "deleted",
      detailAvailable: false,
    });
  });

  it("permanently deletes both the Gmail draft and vm0 row", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["recipient@example.com"],
          subject: "Disposable subject",
          body: "Disposable body",
        },
      }),
      [201],
    );

    const persisted = await accept(
      stateClient().get({
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(persisted.body.exists).toBeTruthy();

    await accept(
      client().deleteDraft({
        headers: authHeaders(),
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [204],
    );
    expect(gmail.deleteCount).toBe(1);

    const deleted = await accept(
      stateClient().get({
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(deleted.body.exists).toBeFalsy();
  });

  it("cleans up active Gmail drafts after deleting their chat thread", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["recipient@example.com"],
          subject: "Thread-owned subject",
          body: "Thread-owned body",
        },
      }),
      [201],
    );

    await chat.deleteThread(fixture.actor, fixture.thread.id);
    await flushWaitUntilForTest();
    expect(gmail.deleteCount).toBe(1);

    const deleted = await accept(
      stateClient().get({
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(deleted.body.exists).toBeFalsy();
  });

  it("deletes the chat thread when Gmail draft cleanup fails", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi();
    let cleanupAttempts = 0;
    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["recipient@example.com"],
          subject: "Provider cleanup failure",
          body: "Thread deletion must still succeed",
        },
      }),
      [201],
    );
    server.use(
      http.delete(`${GMAIL_API_BASE}/drafts/:draftId`, () => {
        cleanupAttempts += 1;
        return HttpResponse.json(
          { error: { message: "Temporary Gmail failure" } },
          { status: 503 },
        );
      }),
    );

    await chat.deleteThread(fixture.actor, fixture.thread.id);
    await flushWaitUntilForTest();
    expect(cleanupAttempts).toBe(1);

    const deleted = await accept(
      stateClient().get({
        params: { mailDraftId: created.body.mailDraftId },
      }),
      [200],
    );
    expect(deleted.body.exists).toBeFalsy();
  });
});
