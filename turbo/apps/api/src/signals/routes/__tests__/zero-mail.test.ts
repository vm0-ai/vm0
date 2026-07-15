import { Buffer } from "node:buffer";

import { zeroMailContract } from "@vm0/api-contracts/contracts/zero-mail";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
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
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

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

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/zero/mail/drafts", () => {
  it("persists edits, sends through Gmail once, and persists sent state", async () => {
    const fixture = await seedGmailMailCardFixture();
    const delivered: {
      readonly authorization: string | null;
      readonly raw: string;
    }[] = [];
    server.use(
      http.post(GMAIL_SEND_URL, async ({ request }) => {
        const body = (await request.json()) as { raw: string };
        delivered.push({
          authorization: request.headers.get("authorization"),
          raw: Buffer.from(body.raw, "base64url").toString("utf8"),
        });
        return HttpResponse.json({ id: "gmail-message-id" });
      }),
    );

    const created = await accept(
      client().createDraft({
        headers: authHeaders(),
        body: {
          threadId: fixture.thread.id,
          agentId: fixture.agent.agentId,
          to: ["first@example.com"],
          subject: "Initial subject",
          body: "Initial body",
        },
      }),
      [201],
    );
    expect(created.body.mailDraft).toMatchObject({
      provider: "gmail",
      from: "sender@example.com",
      status: "draft",
    });

    const edited = await accept(
      client().updateDraft({
        headers: authHeaders(),
        params: {
          threadId: fixture.thread.id,
          messageId: created.body.messageId,
        },
        body: {
          to: ["final@example.com"],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [200],
    );
    expect(edited.body.mailDraft).toMatchObject({
      to: ["final@example.com"],
      subject: "Updated subject",
      body: "Updated body",
      status: "draft",
    });

    const sent = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: {
          threadId: fixture.thread.id,
          messageId: created.body.messageId,
        },
        body: {
          to: ["final@example.com"],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [200],
    );
    expect(sent.body.mailDraft.status).toBe("sent");
    expect(sent.body.mailDraft.sentAt).toBeDefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.authorization).toBe("Bearer gmail-mail-card-token");
    expect(delivered[0]?.raw).toContain("To: final@example.com");
    expect(delivered[0]?.raw).toContain(
      Buffer.from("Updated body", "utf8").toString("base64"),
    );

    const duplicate = await accept(
      client().sendDraft({
        headers: authHeaders(),
        params: {
          threadId: fixture.thread.id,
          messageId: created.body.messageId,
        },
        body: {
          to: ["final@example.com"],
          subject: "Updated subject",
          body: "Updated body",
        },
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain("already been sent");
    expect(delivered).toHaveLength(1);

    const page = await chat.listThreadMessages(
      fixture.actor,
      fixture.thread.id,
    );
    const persisted = page.messages.find((message) => {
      return message.id === created.body.messageId;
    });
    expect(persisted?.mailDraft).toMatchObject({
      to: ["final@example.com"],
      subject: "Updated subject",
      body: "Updated body",
      status: "sent",
    });
  });
});
