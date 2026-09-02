import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { mockedClerk } from "./mock-auth.ts";
import { queryAllByRoleFast, setupPage } from "./page-helper.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

const PRIMARY_LOAD_OPTIONS = {
  afterSignOutUrl: "https://app.vm0.ai/sign-in",
  signInUrl: "https://app.vm0.ai/sign-in",
  signUpUrl: "https://app.vm0.ai/sign-up",
} as const;

async function waitForReadySignIn(): Promise<void> {
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
}

function installEarlyBootstrap(options: {
  readonly clerk?: typeof mockedClerk;
  readonly loaded?: Promise<void>;
}): void {
  context.mocks.clerk();
  const originalBootstrap = window.__vm0ClerkBootstrap;
  const originalClerk = Reflect.get(globalThis, "Clerk");
  Reflect.set(globalThis, "Clerk", options.clerk ?? mockedClerk);
  const bootstrap: NonNullable<Window["__vm0ClerkBootstrap"]> = {
    loadOptions: PRIMARY_LOAD_OPTIONS,
    loaded: options.loaded,
    productionPrimaryAppDomain: "app.vm0.ai",
    publishableKey: "test_production_key",
  };
  if (options.clerk) {
    Reflect.set(bootstrap, "clerk", options.clerk);
  }
  window.__vm0ClerkBootstrap = bootstrap;
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalBootstrap) {
        window.__vm0ClerkBootstrap = originalBootstrap;
      } else {
        Reflect.deleteProperty(window, "__vm0ClerkBootstrap");
      }
      if (originalClerk) {
        Reflect.set(globalThis, "Clerk", originalClerk);
      } else {
        Reflect.deleteProperty(globalThis, "Clerk");
      }
    },
    { once: true },
  );
}

test("Authentication is ready before Platform content becomes interactive", async () => {
  const clerkLoad = context.mocks.clerk().runtimePending();

  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
  });

  const skeleton = await screen.findByTestId("app-skeleton");
  expect(skeleton).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  expect(queryAllByRoleFast("link")).toHaveLength(0);

  clerkLoad.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByTestId("app-auth-v2")).not.toBeInTheDocument();
  expect(queryAllByRoleFast("link").length).toBeGreaterThan(0);
});

test("Authentication startup is reused without a duplicate load", async () => {
  const clerk = context.mocks.clerk();
  const clerkLoad = clerk.runtimePending();
  const loaded = mockedClerk.load(PRIMARY_LOAD_OPTIONS);
  installEarlyBootstrap({ clerk: mockedClerk, loaded });

  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
  });

  await screen.findByTestId("app-skeleton");
  expect(clerk.resourceRequests).toStrictEqual([]);
  expect(clerk.loads).toHaveLength(1);

  clerkLoad.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(clerk.loads).toHaveLength(1);
});

test("Authentication startup retries after an early failure", async () => {
  const clerk = context.mocks.clerk();
  installEarlyBootstrap({});

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
  });

  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([]);
  expect(clerk.loads).toHaveLength(1);
  expect(window.__vm0ClerkBootstrap?.loaded).toBeUndefined();
});

test("Startup onboarding follows the current account and workspace", async () => {
  const statusRequested = context.mocks.deferred<void>();
  const statusReady = context.mocks.deferred<void>();
  let currentIdentityRequests = 0;
  context.mocks.http.get("*/api/onboarding/status", async () => {
    currentIdentityRequests += 1;
    statusRequested.resolve();
    await statusReady.promise;
    return HttpResponse.json({
      defaultAgentId: null,
      defaultAgentMetadata: null,
      hasDefaultAgent: true,
      hasOrg: true,
      isAdmin: true,
      needsOnboarding: true,
      onboardingComplete: false,
    });
  });
  const clerk = context.mocks.clerk();
  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
  });
  await statusRequested.promise;

  clerk.organization({
    activeOrg: { id: "org_current", name: "Current workspace" },
    memberships: [{ id: "org_current" }],
  });
  statusReady.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(currentIdentityRequests).toBe(1);
  expect(
    screen.queryByRole("heading", { name: "What do you want to make first" }),
  ).not.toBeInTheDocument();
});

test("Okou production uses the Okou authentication domain", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });

  await waitFor(() => {
    expect(clerk.resourceRequests).toContainEqual({
      domain: "app.okou.ai",
      publishableKey: "test_production_key",
    });
    expect(clerk.loads).toContainEqual({
      afterSignOutUrl: "https://app.vm0.ai/sign-in",
      isSatellite: true,
      satelliteAutoSync: true,
      signInUrl: "https://app.vm0.ai/sign-in",
      signUpUrl: "https://app.vm0.ai/sign-up",
    });
  });
});

test("VM0 production uses production authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
    auth: null,
  });

  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_production_key" },
  ]);
  expect(clerk.loads).toContainEqual(PRIMARY_LOAD_OPTIONS);
});

test("Authorized preview hosts use preview authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "pr-30199-app.omby.ai",
    path: "/sign-in",
    auth: null,
  });
  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_preview_key" },
  ]);
});

test("Okou lookalike hosts do not use production authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "okou.ai.evil.example",
    path: "/sign-in",
    auth: null,
  });
  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_preview_key" },
  ]);
});

test("VM0 lookalike hosts do not use production authentication", async () => {
  const clerk = context.mocks.clerk();
  await setupPage({
    context,
    host: "app.vm0.ai.evil.example",
    path: "/sign-in",
    auth: null,
  });
  await waitForReadySignIn();
  expect(clerk.resourceRequests).toStrictEqual([
    { domain: undefined, publishableKey: "test_preview_key" },
  ]);
});
