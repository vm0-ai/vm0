import { randomUUID } from "node:crypto";

import {
  onboardingCompleteContract,
  onboardingStatusContract,
} from "@okouai/api-contracts/contracts/onboarding";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroOnboardingCompleteRoutes } from "../zero-onboarding-complete";
import { zeroOnboardingStatusRoutes } from "../zero-onboarding-status";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function onboardingStatusClient() {
  return setupApp({ context, routes: zeroOnboardingStatusRoutes })(
    onboardingStatusContract,
  );
}

function onboardingCompleteClient() {
  return setupApp({ context, routes: zeroOnboardingCompleteRoutes })(
    onboardingCompleteContract,
  );
}

function orgActor(role: "org:admin" | "org:member" = "org:admin") {
  return {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    role,
  } as const;
}

describe("GET /api/zero/onboarding/status", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      onboardingStatusClient().getStatus({ headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("does not start onboarding for an organization member", async () => {
    const actor = orgActor("org:member");
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const response = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      needsOnboarding: false,
      onboardingComplete: false,
      isAdmin: false,
      hasOrg: true,
      hasDefaultAgent: false,
      defaultAgentId: null,
      defaultAgentMetadata: null,
    });
  });
});

describe("POST /api/zero/onboarding/complete", () => {
  it("returns 403 when an organization member tries to complete onboarding", async () => {
    const actor = orgActor("org:member");
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);

    const response = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can complete onboarding",
        code: "FORBIDDEN",
      },
    });
  });

  it("persists an admin's completed onboarding state", async () => {
    const actor = orgActor();
    mocks.clerk.session(actor.userId, actor.orgId, actor.role);
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );

    const before = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(before.body).toMatchObject({
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
    });
    expect(before.body.defaultAgentId).toBeTruthy();

    const completed = await accept(
      onboardingCompleteClient().complete({
        headers: authHeaders(),
        body: {},
      }),
      [200],
    );
    expect(completed.body).toStrictEqual({
      onboardingComplete: true,
      needsOnboarding: false,
    });

    const after = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    expect(after.body).toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
      isAdmin: true,
      hasOrg: true,
      hasDefaultAgent: true,
      defaultAgentId: before.body.defaultAgentId,
    });
  });
});
