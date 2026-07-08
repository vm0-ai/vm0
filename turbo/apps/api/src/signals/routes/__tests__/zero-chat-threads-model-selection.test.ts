import { randomUUID } from "node:crypto";

import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteZeroChatThread$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

function modelSelectionClient() {
  return setupApp({ context })(chatThreadModelSelectionContract);
}

function metadataClient() {
  return setupApp({ context })(chatThreadMetadataContract);
}

describe("POST /api/zero/chat-threads/:id/model-selection", () => {
  const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });
  const trackMembership = createFixtureTracker<OrgMembershipFixture>(
    (fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    },
  );

  it("updates thread model selection with ZERO_TOKEN chat-thread:write capability", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, { title: "Launch plan" }, context.signal),
    );
    await trackMembership(
      store.set(
        seedOrgMembership$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      ),
    );
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read", "chat-thread:write"],
    });

    await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          model: "claude-sonnet-5",
        },
      }),
      [204],
    );

    const response = await accept(
      metadataClient().get({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: fixture.threadId,
      title: "Launch plan",
      selectedModel: "claude-sonnet-5",
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:write capability", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, { title: "Launch plan" }, context.signal),
    );
    await trackMembership(
      store.set(
        seedOrgMembership$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      ),
    );
    const token = zeroToken({
      userId: fixture.userId,
      orgId: fixture.orgId,
      capabilities: ["chat-thread:read"],
    });

    const response = await accept(
      modelSelectionClient().update({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: {
          modelSelection: {
            modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
            selectedModel: "claude-sonnet-5",
          },
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "FORBIDDEN",
        message: "Missing required capability: chat-thread:write",
      },
    });
  });
});
