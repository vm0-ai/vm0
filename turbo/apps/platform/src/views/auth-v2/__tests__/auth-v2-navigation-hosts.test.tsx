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

function withClerkSatelliteSync(url: string): string {
  const destination = new URL(url);
  destination.searchParams.set("__clerk_synced", "false");
  return destination.toString();
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
    host: "app.vm0.ai",
    path: PRESENTATION_ONBOARDING_PATH,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
    expect(location.pathname).toBe("/sign-in");
  });
  const current = new URL(location.href);
  expect(current.searchParams.get("redirect_url")).toBe(
    PRESENTATION_ONBOARDING_URL,
  );
});

test("An Okou sign-in route waits for Clerk before moving to the primary app", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=direct-sign-in";
  const clerk = context.mocks.clerk();
  const clerkResource = clerk.resourcePending();

  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`,
    auth: null,
  });

  await waitFor(() => {
    expect(clerk.resourceRequests).toHaveLength(1);
  });
  expect(location.origin).toBe("https://app.okou.ai");
  expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();

  clerkResource.resolve();

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-in");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith({
    redirectUrl: returnUrl,
  });
});

test("An Okou stateful sign-in route moves authentication to the primary app", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=direct-sign-in";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(returnUrl)}#/identifier`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-in");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(destination.hash).toBe("#/identifier");
});

test("An Okou sign-up route moves registration to the primary app", async () => {
  const returnUrl = "https://app.okou.ai/onboarding?source=direct-sign-up";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-up?redirect_url=${encodeURIComponent(returnUrl)}`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-up");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(mockedClerk.redirectToSignUp).toHaveBeenCalledWith({
    redirectUrl: returnUrl,
  });
});

test("An Okou stateful sign-up route moves registration to the primary app", async () => {
  const returnUrl = "https://app.okou.ai/onboarding?source=direct-sign-up";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-up?redirect_url=${encodeURIComponent(returnUrl)}#/profile`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-up");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(destination.hash).toBe("#/profile");
});

test("Okou sign-up attribution survives the move to the primary app", async () => {
  await startPage({
    context,
    host: "app.okou.ai",
    path: "/sign-up?gclid=click-123&utm_campaign=summer&utm_content=hero&utm_content=footer",
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-up");
  expect(destination.searchParams.get("gclid")).toBe("click-123");
  expect(destination.searchParams.get("utm_campaign")).toBe("summer");
  expect(destination.searchParams.getAll("utm_content")).toStrictEqual([
    "hero",
    "footer",
  ]);
  const redirectUrl = destination.searchParams.get("redirect_url");
  if (!redirectUrl) {
    throw new Error("Expected Clerk to retain the completion destination");
  }
  const completion = new URL(redirectUrl);
  expect(completion.origin).toBe("https://app.okou.ai");
  expect(completion.pathname).toBe("/onboarding");
  expect(completion.searchParams.get("gclid")).toBe("click-123");
  expect(completion.searchParams.get("utm_campaign")).toBe("summer");
  expect(completion.searchParams.getAll("utm_content")).toStrictEqual([
    "hero",
    "footer",
  ]);
  expect(completion.searchParams.get("__clerk_synced")).toBe("false");
});

test("An Okou OAuth callback keeps its state on the primary app", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=oauth-callback";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in/sso-callback?code=oauth-code&state=oauth-state&redirect_url=${encodeURIComponent(
      returnUrl,
    )}#/callback?attempt=1`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-in/sso-callback");
  expect(destination.searchParams.get("code")).toBe("oauth-code");
  expect(destination.searchParams.get("state")).toBe("oauth-state");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(destination.hash).toBe("#/callback?attempt=1");
});

test("An Okou session task keeps its state on the primary app", async () => {
  const returnUrl = "https://app.okou.ai/onboarding?source=session-task";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-up/tasks/choose-organization?session_id=session-test&redirect_url=${encodeURIComponent(
      returnUrl,
    )}#/tasks/choose-organization?attempt=1`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-up/tasks/choose-organization");
  expect(destination.searchParams.get("session_id")).toBe("session-test");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(destination.hash).toBe("#/tasks/choose-organization?attempt=1");
});

test("An Okou sign-in ticket is redeemed by the primary app", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=sign-in-ticket";
  await startPage({
    context,
    host: "app.okou.ai",
    path: `/sign-in-token?token=clerk-ticket&redirect_url=${encodeURIComponent(
      returnUrl,
    )}`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/sign-in-token");
  expect(destination.searchParams.get("token")).toBe("clerk-ticket");
  expect(destination.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
});

test("Satellite auto-sync is not overridden by an extra redirect", async () => {
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
    host: "app.vm0.ai",
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
    host: "app.vm0.ai",
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

test("Okou uses primary authentication with satellite context", async () => {
  const clerk = context.mocks.clerk();
  await startPage({
    context,
    host: "app.okou.ai",
    path: "/agents?utm_source=okou-launch",
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
    expect(location.pathname).toBe("/sign-in");
  });
  const redirect = new URL(location.href).searchParams.get("redirect_url");
  expect(redirect).toBe(
    "https://app.okou.ai/agents?utm_source=okou-launch&__clerk_synced=false",
  );
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

test("Registered Okou subdomains use primary authentication with satellite context", async () => {
  const clerk = context.mocks.clerk();
  await startPage({
    context,
    host: "team.app.okou.ai",
    path: "/agents?utm_source=okou-launch",
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
    expect(location.pathname).toBe("/sign-in");
  });
  const redirect = new URL(location.href).searchParams.get("redirect_url");
  expect(redirect).toBe(
    "https://team.app.okou.ai/agents?utm_source=okou-launch&__clerk_synced=false",
  );
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

test("An unregistered Okou sibling does not get satellite trust", async () => {
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
