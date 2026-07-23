import { Buffer } from "node:buffer";

import { testMailDraftStateContract } from "@vm0/api-contracts/contracts/test-mail-draft-state";
import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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
import {
  seedConnectorStorageRow,
  setConnectorCredentialStorageState,
  setConnectorSecretOwner,
} from "./helpers/connector-credential-storage-state";

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

function encodedBody(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailPayload() {
  return {
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "To", value: "recipient@example.com" },
      { name: "Cc", value: "copy@example.com" },
      { name: "Subject", value: "Attachment review" },
    ],
    body: { size: 0 },
    parts: [
      {
        mimeType: "text/plain",
        filename: "",
        headers: [],
        body: { size: 9, data: encodedBody("Mail body") },
      },
      {
        mimeType: "application/pdf",
        filename: "report.pdf",
        headers: [],
        body: { attachmentId: "attachment-1", size: 248_192 },
      },
    ],
  };
}

interface GmailDraftTestState {
  exists: boolean;
  sendCount: number;
  deleteCount: number;
  sentBody: unknown;
}

function mockGmailDraftApi(): GmailDraftTestState {
  const state: GmailDraftTestState = {
    exists: true,
    sendCount: 0,
    deleteCount: 0,
    sentBody: null,
  };
  server.use(
    http.get(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params, request }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      expect(request.headers.get("authorization")).toBe(
        "Bearer gmail-mail-card-token",
      );
      expect(new URL(request.url).searchParams.get("format")).toBe("full");
      if (!state.exists) {
        return new HttpResponse(null, { status: 404 });
      }
      return HttpResponse.json({
        id: GMAIL_DRAFT_ID,
        message: {
          id: GMAIL_MESSAGE_ID,
          threadId: GMAIL_THREAD_ID,
          payload: gmailPayload(),
        },
      });
    }),
    http.post(`${GMAIL_API_BASE}/drafts/send`, async ({ request }) => {
      state.sentBody = await request.json();
      state.exists = false;
      state.sendCount += 1;
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: GMAIL_THREAD_ID,
      });
    }),
    http.get(`${GMAIL_API_BASE}/messages/:messageId`, ({ params, request }) => {
      expect(params.messageId).toBe(GMAIL_SENT_MESSAGE_ID);
      expect(new URL(request.url).searchParams.get("format")).toBe("full");
      return HttpResponse.json({
        id: GMAIL_SENT_MESSAGE_ID,
        threadId: GMAIL_THREAD_ID,
        payload: gmailPayload(),
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

async function linkDraft(
  fixture: Awaited<ReturnType<typeof seedGmailMailCardFixture>>,
) {
  return await accept(
    client().linkDraft({
      headers: authHeaders(),
      body: {
        threadId: fixture.thread.id,
        agentId: fixture.agent.agentId,
        gmailDraftId: GMAIL_DRAFT_ID,
      },
    }),
    [200],
  );
}

describe("POST /api/zero/mail/drafts/link", () => {
  it("links without injecting a duplicate card and sends without rebuilding MIME", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();

    const linked = await linkDraft(fixture);
    expect(linked.body.mailDraftUrl).toBe(
      `http://localhost:3002/mail/drafts/${linked.body.mailDraftId}`,
    );

    const duplicateLink = await linkDraft(fixture);
    expect(duplicateLink.body).toStrictEqual(linked.body);

    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraft).toMatchObject({
      version: 3,
      provider: "gmail",
      from: "sender@example.com",
      fromName: "Sender",
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Attachment review",
      body: "Mail body",
      status: "draft",
      attachments: [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 248_192,
        },
      ],
    });

    const sent = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(sent.body.mailDraft.status).toBe("sent");
    expect(sent.body.mailDraft.sentGmailMessageId).toBe(GMAIL_SENT_MESSAGE_ID);
    expect(gmail.sentBody).toStrictEqual({ id: GMAIL_DRAFT_ID });
    expect(gmail.sendCount).toBe(1);

    const duplicateSend = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [409],
    );
    expect(duplicateSend.body.error.message).toContain("can no longer be sent");
    expect(gmail.sendCount).toBe(1);

    const page = await chat.listThreadMessages(
      fixture.actor,
      fixture.thread.id,
    );
    expect(page.messages).toHaveLength(0);
  });

  it("rejects a missing Gmail draft and cross-chat relinking", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    gmail.exists = false;

    const missing = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [404],
    );
    expect(missing.body.error.message).toBe("Gmail draft not found");

    gmail.exists = true;
    await linkDraft(fixture);
    const otherThread = await chat.createThread(fixture.actor, {
      agentId: fixture.agent.agentId,
      title: "Other mail review",
    });
    const conflict = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: otherThread.id,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(conflict.body.error.message).toContain("already linked");
  });

  it("does not refresh a known mismatched Gmail storage version", async () => {
    const fixture = await seedGmailMailCardFixture();
    await setConnectorCredentialStorageState(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorRef: "gmail",
      storageVersion: 2,
      tokenExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "must-not-be-written",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Connect and authorize Gmail for this agent first",
    );
    expect(refreshCalls).toBe(0);
  });

  it("does not read Gmail credentials owned by another connector", async () => {
    const fixture = await seedGmailMailCardFixture();
    const foreignConnectorId = await seedConnectorStorageRow(context, {
      orgId: fixture.actor.orgId ?? "",
      userId: fixture.actor.userId,
      connectorRef: "github",
      authMethod: "oauth",
      storageVersion: 1,
    });
    for (const name of ["GMAIL_ACCESS_TOKEN", "GMAIL_REFRESH_TOKEN"]) {
      await setConnectorSecretOwner(context, {
        connectorId: foreignConnectorId,
        name,
        orgId: fixture.actor.orgId ?? "",
        userId: fixture.actor.userId,
      });
    }
    let refreshCalls = 0;
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        refreshCalls += 1;
        return HttpResponse.json({
          access_token: "must-not-be-written",
          expires_in: 3600,
        });
      }),
    );

    const response = await accept(
      client().linkDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          gmailDraftId: GMAIL_DRAFT_ID,
        },
      }),
      [409],
    );
    expect(response.body.error.message).toBe(
      "Reconnect Gmail before continuing",
    );
    expect(refreshCalls).toBe(0);
  });

  it("deletes Gmail only for an explicit draft deletion", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await accept(
      client().deleteDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [204],
    );
    expect(gmail.deleteCount).toBe(1);

    const deleted = await accept(
      stateClient().get({
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(deleted.body.exists).toBeFalsy();
  });

  it("only removes the link when its chat thread is deleted", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await chat.deleteThread(fixture.actor, fixture.thread.id);
    expect(gmail.deleteCount).toBe(0);
    expect(gmail.exists).toBeTruthy();

    const unlinked = await accept(
      stateClient().get({
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(unlinked.body.exists).toBeFalsy();
  });
});
