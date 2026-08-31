import { describe, expect, it, vi } from "vitest";

import {
  type MockedMembership,
  mockedClerk,
} from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { testContext } from "../__tests__/test-helpers.ts";
import { createDeferredPromise } from "../utils.ts";
import {
  createAuthV2ContinuationSignals,
  isAuthV2ContinuationLocation,
  type AuthV2ContinuationSignals,
} from "./continuation.ts";
import type { AuthV2RouteMode } from "./navigation.ts";
import { resolveAuthV2PlatformContext } from "./platform-context.ts";

const context = testContext();

function membership(
  id: string,
  name: string,
  imageUrl?: string,
): MockedMembership {
  return {
    id: `membership_${id}`,
    organization: { id, imageUrl, name },
    role: "org:member",
  };
}

async function setupContinuation(options: {
  readonly memberships?: MockedMembership[];
  readonly mode?: AuthV2RouteMode;
  readonly path?: string;
  readonly taskKey?: string;
}): Promise<AuthV2ContinuationSignals> {
  const path = options.path ?? "/sign-in/tasks/choose-organization";
  const memberships = options.memberships ?? [];
  context.mocks.browser.url(`https://app.vm0.ai${path}`);
  await setupPage({
    context,
    org: { activeOrg: null, memberships },
    path,
    session: { token: "test-token" },
    user: {
      clientSessions: options.taskKey
        ? [
            {
              currentTask: { key: options.taskKey },
              id: "session_pending",
              status: "pending",
              user: {
                fullName: "Test User",
                organizationMemberships: memberships,
                primaryEmailAddress: { emailAddress: "test@example.com" },
              },
            },
          ]
        : [],
      fullName: "Test User",
      id: "user_test",
    },
    withoutRender: true,
  });
  const mode = options.mode ?? "sign-in";
  const platformContext = resolveAuthV2PlatformContext(mode);
  return createAuthV2ContinuationSignals({
    isContinuationRoute: isAuthV2ContinuationLocation(
      location.pathname,
      location.hash,
    ),
    mode,
    navigation: platformContext.navigation,
    presentation: "route",
  });
}

async function initialize(signals: AuthV2ContinuationSignals): Promise<void> {
  await context.store.set(signals.initialize$, context.signal);
}

describe("auth v2 continuation recovery", () => {
  it("recognizes pathname and Clerk hash task refresh routes", () => {
    expect(
      isAuthV2ContinuationLocation("/sign-in/tasks/choose-organization", ""),
    ).toBe(true);
    expect(
      isAuthV2ContinuationLocation(
        "/sign-in",
        "#/tasks/choose-organization?attempt=1",
      ),
    ).toBe(true);
    expect(isAuthV2ContinuationLocation("/sign-in/factor-one", "")).toBe(false);
  });

  it("recovers a pending organization task with existing memberships only", async () => {
    const memberships = [
      membership(
        "org_alpha",
        "Alpha Company",
        "https://cdn.vm0.test/orgs/alpha.png",
      ),
      membership("org_beta", "Beta Studio"),
    ];
    const signals = await setupContinuation({
      memberships,
      taskKey: "choose-organization",
    });

    expect(context.store.get(signals.state$)).toStrictEqual({
      status: "loading",
    });
    await initialize(signals);

    expect(context.store.get(signals.state$)).toStrictEqual({
      accountIdentifier: "test@example.com",
      organizations: [
        {
          id: "org_alpha",
          imageUrl: "https://cdn.vm0.test/orgs/alpha.png",
          name: "Alpha Company",
        },
        { id: "org_beta", imageUrl: null, name: "Beta Studio" },
      ],
      selectingOrganizationId: null,
      status: "incomplete",
      task: "choose-organization",
    });
  });

  it("coalesces duplicate membership selection and redirects once", async () => {
    const memberships = [
      membership("org_alpha", "Alpha Company"),
      membership("org_beta", "Beta Studio"),
    ];
    const signals = await setupContinuation({
      memberships,
      path: `/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent("https://app.vm0.ai/agents")}`,
      taskKey: "choose-organization",
    });
    await initialize(signals);
    const activation = createDeferredPromise<void>(context.signal);
    mockedClerk.setActive.mockImplementation(async (params) => {
      await activation.promise;
      await params.navigate?.({
        decorateUrl: (url) => {
          return url;
        },
        session: {
          id: "session_pending",
          status: "active",
          user: { organizationMemberships: memberships },
        },
      });
    });

    const firstSelection = context.store.set(
      signals.selectOrganization$,
      "org_beta",
      context.signal,
    );
    const duplicateSelection = context.store.set(
      signals.selectOrganization$,
      "org_beta",
      context.signal,
    );
    await vi.waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      organization: "org_beta",
    });

    activation.resolve();
    await Promise.all([firstSelection, duplicateSelection]);

    await vi.waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(location.pathname).toBe("/agents");
    expect(context.store.get(signals.state$)).toStrictEqual({
      status: "complete",
    });
  });
});

describe("auth v2 continuation route ownership", () => {
  it("keeps a completed sign-up task on the nested sign-up route", async () => {
    const signals = await setupContinuation({
      mode: "sign-up",
      path: "/sign-up",
    });
    await initialize(signals);
    const memberships = [membership("org_alpha", "Alpha Company")];
    mockedClerk.setActive.mockImplementation(async (params) => {
      await params.navigate?.({
        decorateUrl: (url) => {
          return url;
        },
        session: {
          currentTask: { key: "choose-organization" },
          id: "session_sign_up",
          status: "pending",
          user: { organizationMemberships: memberships },
        },
      });
    });

    await context.store.set(
      signals.completeSession$,
      "session_sign_up",
      context.signal,
    );

    expect(location.pathname).toBe("/sign-up/tasks/choose-organization");
    expect(context.store.get(signals.state$)).toStrictEqual({
      accountIdentifier: "Account",
      organizations: [
        { id: "org_alpha", imageUrl: null, name: "Alpha Company" },
      ],
      selectingOrganizationId: null,
      status: "incomplete",
      task: "choose-organization",
    });
  });
});

describe("auth v2 continuation terminal states", () => {
  it("coalesces duplicate completed-session activation", async () => {
    const signals = await setupContinuation({ path: "/sign-in" });
    await initialize(signals);
    const activation = createDeferredPromise<void>(context.signal);
    mockedClerk.setActive.mockImplementation(async (params) => {
      await activation.promise;
      await params.navigate?.({
        decorateUrl: (url) => {
          return url;
        },
        session: {
          id: "session_complete",
          status: "active",
          user: { organizationMemberships: [] },
        },
      });
    });

    const firstCompletion = context.store.set(
      signals.completeSession$,
      "session_complete",
      context.signal,
    );
    const duplicateCompletion = context.store.set(
      signals.completeSession$,
      "session_complete",
      context.signal,
    );
    await vi.waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });

    activation.resolve();
    await Promise.all([firstCompletion, duplicateCompletion]);

    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    expect(location.pathname).toBe("/");
  });

  it.each([
    { expectedReason: "unsupported-task", taskKey: "reset-password" },
    { expectedReason: "second-factor", taskKey: "setup-mfa" },
    { expectedReason: "unknown-task", taskKey: "future-task" },
  ] as const)(
    "fails closed for the $taskKey task",
    async ({ expectedReason, taskKey }) => {
      const signals = await setupContinuation({ taskKey });

      await initialize(signals);

      expect(context.store.get(signals.state$)).toStrictEqual({
        reason: expectedReason,
        status: "unknown",
      });
      expect(mockedClerk.setActive).not.toHaveBeenCalled();
    },
  );

  it("fails closed when forced selection has no existing membership", async () => {
    const signals = await setupContinuation({
      memberships: [],
      taskKey: "choose-organization",
    });

    await initialize(signals);

    expect(context.store.get(signals.state$)).toStrictEqual({
      reason: "no-organizations",
      status: "failure",
    });
  });

  it("surfaces session activation failure without retrying", async () => {
    const sessionSignals = await setupContinuation({ path: "/sign-in" });
    await initialize(sessionSignals);
    mockedClerk.setActive.mockRejectedValueOnce(
      new Error("sensitive session activation response"),
    );

    await context.store.set(
      sessionSignals.completeSession$,
      "session_private",
      context.signal,
    );

    expect(context.store.get(sessionSignals.state$)).toStrictEqual({
      reason: "activation-failed",
      status: "failure",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });

  it("surfaces organization activation failure without retrying", async () => {
    const memberships = [membership("org_alpha", "Alpha Company")];
    const organizationSignals = await setupContinuation({
      memberships,
      taskKey: "choose-organization",
    });
    await initialize(organizationSignals);
    mockedClerk.setActive.mockRejectedValueOnce(
      new Error("sensitive organization activation response"),
    );

    await context.store.set(
      organizationSignals.selectOrganization$,
      "org_alpha",
      context.signal,
    );

    expect(context.store.get(organizationSignals.state$)).toStrictEqual({
      reason: "organization-activation-failed",
      status: "failure",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
});
