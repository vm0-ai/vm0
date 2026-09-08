import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  PRESENTATION_ONBOARDING_PATH,
  PRESENTATION_ONBOARDING_URL,
} from "../../../__tests__/presentation-onboarding-fixture.ts";
import {
  mockedClerk,
  mockSignInResource,
  type MockedSignInResourceState,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function clerkAuthFragment(url: URL): URL {
  if (!url.hash.startsWith("#/")) {
    throw new Error("Expected Clerk auth state in the URL fragment");
  }
  return new URL(url.hash.slice(1), url.origin);
}

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function roleElement(
  role: "button" | "link",
  name: string,
): HTMLElement | undefined {
  return queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

function requiredRoleElement(
  role: "button" | "link",
  name: string,
): HTMLElement {
  const element = roleElement(role, name);
  if (!element) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return element;
}

test("A presentation-onboarding deep link survives sign-in", async () => {
  await startPage({
    context,
    host: "app.okou.ai",
    path: PRESENTATION_ONBOARDING_PATH,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.okou.ai");
    expect(location.pathname).toBe("/sign-in");
  });
  const current = new URL(location.href);
  expect(clerkAuthFragment(current).searchParams.get("redirect_url")).toBe(
    PRESENTATION_ONBOARDING_URL,
  );
});

test("A loading page is not redirected away from its own origin", async () => {
  context.mocks.clerk().loaded(false);

  await startPage({
    context,
    host: "app.okou.ai",
    path: "/agents?utm_source=okou-launch",
    auth: null,
  });

  await expect(
    screen.findByRole("status", { name: "Loading" }),
  ).resolves.toBeVisible();
  expect(location.href).toBe(
    "https://app.okou.ai/agents?utm_source=okou-launch",
  );
});

test("A trusted destination from callback state is preserved", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=callback";
  const identification =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockReturnValueOnce(identification.promise);

  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(
      redirectUrl,
    )}#/callback?attempt=1`,
    auth: null,
  });

  const identifier = await screen.findByLabelText("Email address");
  await fill(identifier, "person@example.com");
  fireEvent.submit(containingForm(identifier));
  identification.resolve(
    moveSignInTo({
      identifier: "person@example.com",
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    }),
  );

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
  const nestedStep = new URL(location.href);
  expect(nestedStep.searchParams.get("redirect_url")).toBe(redirectUrl);
  expect(nestedStep.hash).toBe("#/callback?attempt=1");
});

test("A trusted destination survives every authentication step", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
  const identification =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockReturnValueOnce(identification.promise);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in?flow=identifier&redirect_url=${encodeURIComponent(
      redirectUrl,
    )}&flow=second#/factor-one?attempt=1`,
    auth: null,
  });
  const identifier = await screen.findByLabelText("Email address");
  await fill(identifier, "person@example.com");
  fireEvent.submit(containingForm(identifier));
  identification.resolve(
    moveSignInTo({
      identifier: "person@example.com",
      status: "needs_first_factor",
      supportedFirstFactors: [
        { strategy: "password" },
        {
          emailAddressId: "email_primary",
          safeIdentifier: "p***@example.com",
          strategy: "email_code",
        },
      ],
    }),
  );

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
  const nested = new URL(location.href);
  expect(nested.searchParams.getAll("flow")).toStrictEqual([
    "identifier",
    "second",
  ]);
  expect(nested.searchParams.get("redirect_url")).toBe(redirectUrl);
  expect(nested.hash).toBe("#/factor-one?attempt=1");

  click(requiredRoleElement("button", "Edit identifier"));
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  const signUpLink = requiredRoleElement("link", "Sign up");
  const signUp = new URL(
    signUpLink.getAttribute("href") ?? "",
    location.origin,
  );
  expect(signUp.pathname).toBe("/sign-up");
  expect(signUp.searchParams.get("redirect_url")).toBe(redirectUrl);
  click(signUpLink);
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
  });
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    redirectUrl,
  );
});

test("Preview authentication stays in the preview environment", async () => {
  const clerk = context.mocks.clerk();
  await startPage({
    context,
    host: "pr-18532-app.omby.ai:8443",
    path: "/agents",
    auth: null,
  });

  await waitFor(() => {
    expect(location.pathname).toBe("/sign-in");
  });
  const signInUrl = new URL(location.href);
  expect(signInUrl.origin).toBe("https://pr-18532-app.omby.ai:8443");
  expect(signInUrl.pathname).toBe("/sign-in");
  expect(signInUrl.searchParams.has("domain")).toBeFalsy();
  expect(clerk.loads).toContainEqual({
    afterSignOutUrl: "https://pr-18532-app.omby.ai:8443/sign-in",
    signInUrl: "https://pr-18532-app.omby.ai:8443/sign-in",
    signUpUrl: "https://pr-18532-app.omby.ai:8443/sign-up",
  });
});

test("An unregistered Okou sibling authenticates against itself", async () => {
  const clerk = context.mocks.clerk();
  await startPage({
    context,
    host: "console.okou.ai",
    path: "/agents",
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://console.okou.ai");
    expect(location.pathname).toBe("/sign-in");
  });
  expect(new URL(location.href).searchParams.has("domain")).toBeFalsy();
  expect(clerk.loads).toContainEqual({
    afterSignOutUrl: "https://console.okou.ai/sign-in",
    signInUrl: "https://console.okou.ai/sign-in",
    signUpUrl: "https://console.okou.ai/sign-up",
  });
});
