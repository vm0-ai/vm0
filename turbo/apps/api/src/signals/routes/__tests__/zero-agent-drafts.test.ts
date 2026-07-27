import { randomUUID } from "node:crypto";

import {
  addClientCapabilityToVersion,
  CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import { zeroAgentDraftContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { UserMessageDocument } from "@vm0/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);

interface AgentDraftFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

/** Creates an agent through the product routes. */
async function seedAgent(): Promise<AgentDraftFixture> {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Agent draft agent",
  });
  if (!actor.orgId) {
    throw new Error("Expected the seeded actor to belong to an org");
  }
  return { userId: actor.userId, orgId: actor.orgId, agentId: agent.agentId };
}

const CLIENT_VERSION = addClientCapabilityToVersion(
  "0.636.1",
  CLIENT_CAPABILITY_STRUCTURED_FEEDBACK_PARTS,
);

function authHeaders() {
  return {
    authorization: "Bearer clerk-session",
    [CLIENT_VERSION_HEADER]: CLIENT_VERSION,
  };
}

function draftsClient() {
  return setupApp({ context })(zeroAgentDraftContract);
}

describe("GET/PATCH /api/zero/agents/:id/draft", () => {
  it("returns an empty draft when none is saved", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      draftContent: null,
      draftStructuredPrompt: null,
      draftAttachments: null,
    });
  });

  it("stores and clears the current user's agent draft", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const attachment = {
      id: randomUUID(),
      url: "https://cdn.example.com/draft-file.txt",
      filename: "draft-file.txt",
      contentType: "text/plain",
      size: 123,
    };
    const draftStructuredPrompt: UserMessageDocument = {
      version: 1,
      parts: [
        {
          type: "file",
          fileId: attachment.id,
          filenameSnapshot: attachment.filename,
          contentType: attachment.contentType,
        },
        { type: "text", text: "draft text" },
        {
          type: "feedback",
          quote: "draft text",
          note: [{ type: "text", text: "Tighten this draft." }],
        },
      ],
    };

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftContent: "draft text",
          draftStructuredPrompt,
          draftAttachments: [attachment],
        },
      }),
      [204],
    );

    const saved = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      draftContent: "draft text",
      draftStructuredPrompt,
      draftAttachments: [attachment],
    });

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftContent: null,
          draftStructuredPrompt: null,
          draftAttachments: null,
        },
      }),
      [204],
    );

    const cleared = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(cleared.body).toStrictEqual({
      draftContent: null,
      draftStructuredPrompt: null,
      draftAttachments: null,
    });
  });

  it("does not expose another user's draft on the same public agent", async () => {
    const fixture = await seedAgent();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      draftsClient().patch({
        params: { id: fixture.agentId },
        headers: authHeaders(),
        body: {
          draftContent: "owner draft",
          draftAttachments: null,
        },
      }),
      [204],
    );

    const peerUserId = `user_${randomUUID()}`;
    mocks.clerk.session(peerUserId, fixture.orgId, "org:member");

    const peerDraft = await accept(
      draftsClient().get({
        params: { id: fixture.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(peerDraft.body).toStrictEqual({
      draftContent: null,
      draftStructuredPrompt: null,
      draftAttachments: null,
    });
  });
});
