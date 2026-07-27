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
const GMAIL_IMAGE_ATTACHMENT_ID = "attachment-image";
const GMAIL_IMAGE_BYTES = Buffer.from("mail draft image");
const GMAIL_PDF_BYTES = Buffer.from("mail draft pdf");
const GMAIL_TEXT_BYTES = Buffer.from("mail draft decision");
const GMAIL_HTML_BODY =
  '<div>Mail body <strong>before</strong></div><img src="cid:email-test-illustration" alt="Cheerful envelope illustration"><ul><li>Mail body after</li></ul><a href="https://example.com/review">Review</a>';

function encodedBody(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailPayload(
  imageAttachmentId: string | null = GMAIL_IMAGE_ATTACHMENT_ID,
  pdfAttachmentId: string | null = "attachment-1",
  includeTextAttachment = false,
) {
  return {
    partId: "",
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
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [
          {
            partId: "0.0",
            mimeType: "text/plain",
            filename: "",
            headers: [],
            body: { size: 9, data: encodedBody("Mail body") },
          },
          {
            partId: "0.1",
            mimeType: "text/html",
            filename: "",
            headers: [],
            body: {
              size: 180,
              data: encodedBody(GMAIL_HTML_BODY),
            },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "report.pdf",
        headers: [],
        body:
          pdfAttachmentId === null
            ? {
                size: GMAIL_PDF_BYTES.byteLength,
                data: GMAIL_PDF_BYTES.toString("base64url"),
              }
            : { attachmentId: pdfAttachmentId, size: 248_192 },
      },
      {
        partId: "2",
        mimeType: "image/png",
        filename: "email-test-illustration.png",
        headers: [
          {
            name: "Content-ID",
            value: "<email-test-illustration>",
          },
          {
            name: "Content-Disposition",
            value: 'inline; filename="email-test-illustration.png"',
          },
        ],
        body:
          imageAttachmentId === null
            ? {
                size: GMAIL_IMAGE_BYTES.byteLength,
                data: GMAIL_IMAGE_BYTES.toString("base64url"),
              }
            : {
                attachmentId: imageAttachmentId,
                size: GMAIL_IMAGE_BYTES.byteLength,
              },
      },
      ...(includeTextAttachment
        ? [
            {
              partId: "3",
              mimeType: "text/plain",
              filename: "decision.txt",
              headers: [],
              body: {
                size: GMAIL_TEXT_BYTES.byteLength,
                data: GMAIL_TEXT_BYTES.toString("base64url"),
              },
            },
          ]
        : []),
    ],
  };
}

interface GmailDraftTestState {
  exists: boolean;
  unauthorized: boolean;
  draftReadCount: number;
  sendCount: number;
  deleteCount: number;
  sentBody: unknown;
}

function mockGmailDraftApi(options?: {
  readonly inlineImageData?: boolean;
  readonly regularAttachmentData?: boolean;
  readonly textAttachmentData?: boolean;
}): GmailDraftTestState {
  const state: GmailDraftTestState = {
    exists: true,
    unauthorized: false,
    draftReadCount: 0,
    sendCount: 0,
    deleteCount: 0,
    sentBody: null,
  };
  let currentImageAttachmentId = GMAIL_IMAGE_ATTACHMENT_ID;
  server.use(
    http.get(`${GMAIL_API_BASE}/drafts/:draftId`, ({ params, request }) => {
      expect(params.draftId).toBe(GMAIL_DRAFT_ID);
      expect(request.headers.get("authorization")).toBe(
        "Bearer gmail-mail-card-token",
      );
      expect(new URL(request.url).searchParams.get("format")).toBe("full");
      state.draftReadCount += 1;
      if (state.unauthorized) {
        return HttpResponse.json(
          { error: { message: "Invalid Credentials" } },
          { status: 401 },
        );
      }
      if (!state.exists) {
        return new HttpResponse(null, { status: 404 });
      }
      currentImageAttachmentId = `${GMAIL_IMAGE_ATTACHMENT_ID}-${state.draftReadCount}`;
      return HttpResponse.json({
        id: GMAIL_DRAFT_ID,
        message: {
          id: GMAIL_MESSAGE_ID,
          threadId: GMAIL_THREAD_ID,
          payload: gmailPayload(
            options?.inlineImageData ? null : currentImageAttachmentId,
            options?.regularAttachmentData ? null : "attachment-1",
            options?.textAttachmentData,
          ),
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
    http.get(
      `${GMAIL_API_BASE}/messages/:messageId/attachments/:attachmentId`,
      ({ params, request }) => {
        expect(params.messageId).toBe(GMAIL_MESSAGE_ID);
        expect(params.attachmentId).toBe(currentImageAttachmentId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-mail-card-token",
        );
        return HttpResponse.json({
          size: GMAIL_IMAGE_BYTES.byteLength,
          data: GMAIL_IMAGE_BYTES.toString("base64url"),
        });
      },
    ),
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
      bodyHtml: GMAIL_HTML_BODY,
      inlineImages: [
        {
          contentId: "email-test-illustration",
          partId: "2",
          alt: "Cheerful envelope illustration",
        },
      ],
      status: "draft",
      attachments: [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 248_192,
          partId: "1",
        },
      ],
    });

    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "2",
        },
      }),
      [200],
    );
    expect(attachment.body).toBeInstanceOf(Blob);
    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(
        GMAIL_IMAGE_BYTES,
      ),
    ).toBeTruthy();
    expect(attachment.headers.get("content-type")).toBe("image/png");
    expect(attachment.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''email-test-illustration.png",
    );

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

  it("serves an inline image stored directly in the Gmail MIME body", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi({ inlineImageData: true });

    const linked = await linkDraft(fixture);
    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "2",
        },
      }),
      [200],
    );

    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(
        GMAIL_IMAGE_BYTES,
      ),
    ).toBeTruthy();
  });

  it("serves regular attachments stored directly in the Gmail MIME body", async () => {
    const fixture = await seedGmailMailCardFixture();
    mockGmailDraftApi({
      regularAttachmentData: true,
      textAttachmentData: true,
    });

    const linked = await linkDraft(fixture);
    const loaded = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(loaded.body.mailDraft.attachments).toContainEqual({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: GMAIL_PDF_BYTES.byteLength,
      partId: "1",
    });

    const attachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "1",
        },
      }),
      [200],
    );
    expect(
      Buffer.from(await attachment.body.arrayBuffer()).equals(GMAIL_PDF_BYTES),
    ).toBeTruthy();

    const textAttachment = await accept(
      client().getAttachment({
        headers: authHeaders(),
        params: {
          mailDraftId: linked.body.mailDraftId,
          partId: "3",
        },
      }),
      [200],
    );
    expect(textAttachment.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(
      Buffer.from(await textAttachment.body.arrayBuffer()).equals(
        GMAIL_TEXT_BYTES,
      ),
    ).toBeTruthy();
  });

  it("returns cached mail details and requires reconnect after Gmail rejects access", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);
    gmail.unauthorized = true;

    const unavailable = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(unavailable.body.mailDraft).toMatchObject({
      accessStatus: "reconnect",
      detailAvailable: false,
      status: "draft",
      subject: "Attachment review",
    });

    const gmailReadsAfterUnauthorized = gmail.draftReadCount;
    const cached = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(cached.body.mailDraft.accessStatus).toBe("reconnect");
    expect(gmail.draftReadCount).toBe(gmailReadsAfterUnauthorized);
  });

  it("restores a draft after its Gmail connector is reconnected", async () => {
    const fixture = await seedGmailMailCardFixture();
    const gmail = mockGmailDraftApi();
    const linked = await linkDraft(fixture);

    await connectors.deleteConnectorByType(fixture.actor, "gmail");
    const start = await connectors.startOauth(fixture.actor, "gmail", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Gmail OAuth state");
    }
    await connectors.completeOauthCallback("gmail", {
      code: "zero-mail-reconnect-code",
      state,
    });

    const restored = await accept(
      client().getDraft({
        headers: authHeaders(),
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(restored.body.mailDraft).toMatchObject({
      accessStatus: "ready",
      detailAvailable: true,
      from: "sender@example.com",
      status: "draft",
      subject: "Attachment review",
    });
    expect(gmail.draftReadCount).toBe(2);
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

  it("deletes Gmail without removing the linked mail draft", async () => {
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

    const preserved = await accept(
      stateClient().get({
        params: { mailDraftId: linked.body.mailDraftId },
      }),
      [200],
    );
    expect(preserved.body.exists).toBeTruthy();
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
