import { randomUUID } from "node:crypto";

import { chatThreadRenameContract } from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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

function client() {
  return setupApp({ context })(chatThreadRenameContract);
}

describe("POST /api/zero/chat-threads/:id/rename", () => {
  const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });
  const trackMembership = createFixtureTracker<OrgMembershipFixture>(
    (fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    },
  );

  it("renames a thread with ZERO_TOKEN chat-thread:write capability", async () => {
    const fixture = await trackThread(
      store.set(
        seedZeroChatThread$,
        { title: "Original title" },
        context.signal,
      ),
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
      capabilities: ["chat-thread:write"],
    });

    const response = await accept(
      client().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "CLI renamed title" },
      }),
      [204],
    );
    expect(response.status).toBe(204);

    const [thread] = await store
      .set(writeDb$)
      .select({ title: chatThreads.title, renamedAt: chatThreads.renamedAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, fixture.threadId))
      .limit(1);
    expect(thread).toStrictEqual({
      title: "CLI renamed title",
      renamedAt: expect.any(Date),
    });
  });

  it("rejects ZERO_TOKEN without chat-thread:write capability", async () => {
    const fixture = await trackThread(
      store.set(
        seedZeroChatThread$,
        { title: "Original title" },
        context.signal,
      ),
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
      capabilities: ["chat-message:read"],
    });

    const response = await accept(
      client().rename({
        headers: { authorization: `Bearer ${token}` },
        params: { id: fixture.threadId },
        body: { title: "Unauthorized title" },
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
