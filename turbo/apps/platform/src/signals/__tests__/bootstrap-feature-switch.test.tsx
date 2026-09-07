import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  emitMockedClerkEvent,
  mockClerkSessionTransitioning,
} from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  expectComposerModel,
  mockAgent,
  mockOrgModelRoutes,
} from "../../views/okou-page/__tests__/chat-composer-test-helpers.ts";

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

test("A signed-in workspace receives its enabled features", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedFeatureSwitches: {
      [FeatureSwitchKey.IntroVideo]: false,
    },
    featureSwitches: {
      [FeatureSwitchKey.IntroVideo]: true,
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await expect(
    screen.findByTestId("intro-video-start-card"),
  ).resolves.toBeVisible();
});

async function setupIntroVideoRolloutPage(args: {
  readonly email: string;
  readonly fullName: string;
  readonly userId: string;
}) {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: {
        [FeatureSwitchKey.IntroVideo]: false,
      },
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: { id: args.userId, fullName: args.fullName, email: args.email },
      organization: {
        activeOrg: { id: STAFF_ORG_ID, name: "Staff" },
        memberships: [{ id: STAFF_ORG_ID }],
      },
    },
    cachedFeatureSwitches: {
      [FeatureSwitchKey.IntroVideo]: false,
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
}

test("Bingjie retains the intro video rollout after hydration", async () => {
  await setupIntroVideoRolloutPage({
    email: "BINGJIE@VM0.AI",
    fullName: "Bingjie",
    userId: "user_bingjie",
  });

  await expect(
    screen.findByTestId("intro-video-start-card"),
  ).resolves.toBeVisible();
});

test("another staff member does not receive the intro video rollout", async () => {
  await setupIntroVideoRolloutPage({
    email: "ethan@vm0.ai",
    fullName: "Another staff member",
    userId: "user_other_staff",
  });

  expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
});

test("Image recognition remains available by default", async () => {
  const user = userEvent.setup({ delay: null });
  mockOrgModelRoutes("claude-opus-5");
  mockAgent();
  context.mocks.upload.success({
    id: "default-image-recognition-upload",
    filename: "workspace-map.png",
    contentType: "image/png",
    size: 3,
    url: "https://example.com/workspace-map.png",
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await expectComposerModel("Claude Opus 5");
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) {
    throw new Error("Composer file input not found");
  }

  await user.upload(
    fileInput,
    new File(["png"], "workspace-map.png", { type: "image/png" }),
  );

  await expect(
    screen.findByLabelText("Open image preview for workspace-map.png"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(/Claude Opus 5 cannot recognize images or videos/iu),
  ).not.toBeInTheDocument();
});

test("A signed-out page does not load workspace features", async () => {
  let workspaceFeatureRequested = false;
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    workspaceFeatureRequested = true;
    return respond(200, {
      switches: { [FeatureSwitchKey.AhrefsConnector]: true },
      effectiveSwitches: { [FeatureSwitchKey.AhrefsConnector]: true },
    });
  });

  await setupPage({
    context,
    path: "/sign-in",
    auth: null,
  });

  await screen.findByRole("heading", { name: "Sign in to VM0" });

  expect(screen.queryByText("Ahrefs")).not.toBeInTheDocument();
  expect(workspaceFeatureRequested).toBeFalsy();
});

test("A feature response is discarded after identity changes", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const requestStarted = context.mocks.deferred<void>();
  const requestCancelled = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  let originalRequestPending = true;
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, signal, withSignal }) => {
      if (!originalRequestPending) {
        return respond(200, {
          switches: { [FeatureSwitchKey.Lab]: true },
          effectiveSwitches: { [FeatureSwitchKey.Lab]: true },
        });
      }
      originalRequestPending = false;
      signal.addEventListener(
        "abort",
        () => {
          requestCancelled.resolve(undefined);
        },
        { once: true },
      );
      requestStarted.resolve(undefined);
      await withSignal(releaseResponse.promise);
      return respond(200, {
        switches: {
          [FeatureSwitchKey.IntroVideo]: true,
        },
        effectiveSwitches: {
          [FeatureSwitchKey.IntroVideo]: true,
        },
      });
    },
  );

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedFeatureSwitches: {
      [FeatureSwitchKey.IntroVideo]: false,
    },
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
  await requestStarted.promise;

  mockClerkSessionTransitioning(true);
  await requestCancelled.promise;
  releaseResponse.resolve(undefined);
  mockClerkSessionTransitioning(false);

  expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
});

test("The same identity can finish feature loading through an auth refresh", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const requestStarted = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    requestStarted.resolve(undefined);
    await releaseResponse.promise;
    return respond(200, {
      switches: {
        [FeatureSwitchKey.IntroVideo]: true,
      },
      effectiveSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
      },
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedFeatureSwitches: {
      [FeatureSwitchKey.IntroVideo]: false,
    },
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByTestId("intro-video-start-card")).toBeNull();
  await requestStarted.promise;

  emitMockedClerkEvent();
  releaseResponse.resolve(undefined);

  await expect(
    screen.findByTestId("intro-video-start-card"),
  ).resolves.toBeVisible();
});
