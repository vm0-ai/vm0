import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
  type MockedSignInResourceState,
  type MockedSignUpResourceState,
} from "../../../__tests__/mock-auth.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();
const ATTRIBUTION_NOW = Date.parse("2026-08-25T08:00:00.000Z");

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
}

function moveSignInToAsync(
  state: MockedSignInResourceState,
): Promise<ReturnType<typeof currentSignInResource>> {
  return Promise.resolve(moveSignInTo(state));
}

function currentSignUpResource() {
  return mockedClerk.client.signUp;
}

function moveSignUpTo(state: MockedSignUpResourceState) {
  mockSignUpResource(state);
  return currentSignUpResource();
}

function moveSignUpToAsync(
  state: MockedSignUpResourceState,
): Promise<ReturnType<typeof currentSignUpResource>> {
  return Promise.resolve(moveSignUpTo(state));
}

function readyVerificationState(
  overrides: Partial<MockedSignUpResourceState> = {},
): MockedSignUpResourceState {
  return {
    emailAddress: "person@example.com",
    emailVerificationExpireAt: new Date(ATTRIBUTION_NOW + 10 * 60 * 1000),
    emailVerificationStatus: "unverified",
    emailVerificationStrategy: "email_code",
    hasPassword: true,
    missingFields: [],
    status: "missing_requirements",
    unverifiedFields: ["email_address"],
    ...overrides,
  };
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

function waitForRoleElement(
  role: "button" | "link",
  name: string,
): Promise<HTMLElement> {
  return waitFor(() => {
    const element = roleElement(role, name);
    if (!element) {
      throw new Error(`Expected ${role} named ${name}`);
    }
    return element;
  });
}

function setupSignedOutPage(path: string, host = "app.vm0.ai"): Promise<void> {
  mockNow(ATTRIBUTION_NOW, context.signal);
  return setupPage({ auth: null, context, host, path });
}

function prepareAccountCreation(): void {
  mockedClerk.clientSignUpCreate.mockImplementation(() => {
    return moveSignUpToAsync(
      readyVerificationState({
        emailVerificationExpireAt: null,
        emailVerificationStatus: null,
        emailVerificationStrategy: null,
      }),
    );
  });
  mockedClerk.signUpPrepareEmailAddressVerification.mockImplementation(() => {
    return moveSignUpToAsync(readyVerificationState());
  });
}

async function advanceToEmailVerification(): Promise<HTMLElement> {
  const emailInput = await screen.findByLabelText("Email address");
  const passwordInput = screen.getByLabelText("Password");
  await fill(emailInput, "person@example.com");
  await fill(passwordInput, "valid-password");
  fireEvent.submit(containingForm(emailInput));
  const verificationRegion = await screen.findByRole("region", {
    name: "Verify your email",
  });
  return within(verificationRegion).getByLabelText("Verification code");
}

function preparePasswordSignIn(): void {
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    return moveSignInToAsync({
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    });
  });
  mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
    return moveSignInToAsync({
      createdSessionId: "session_password",
      status: "complete",
    });
  });
}

async function completePasswordSignIn(): Promise<void> {
  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, "person@example.com");
  fireEvent.submit(containingForm(identifierInput));
  const passwordInput = await screen.findByLabelText("Password");
  await fill(passwordInput, "correct-password");
  fireEvent.submit(containingForm(passwordInput));
  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
}

test("Campaign attribution survives a switch from sign-in to sign-up", async () => {
  const path =
    "/sign-in?gclid=click-123&utm_campaign=summer#/factor-one?step=code";
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    return moveSignInToAsync({
      identifier: "person@example.com",
      isTransferable: true,
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    });
  });
  await setupSignedOutPage(path);

  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, "person@example.com");
  fireEvent.submit(containingForm(identifierInput));

  await waitForRoleElement("button", "Use another method");
  const signUp = await waitForRoleElement("link", "Sign up");
  const signUpUrl = new URL(signUp.getAttribute("href") ?? "", location.origin);
  expect(search()).toContain("gclid=click-123");
  expect(search()).toContain("utm_campaign=summer");
  expect(search()).not.toContain("redirect_url");
  expect(signUpUrl.searchParams.get("gclid")).toBe("click-123");
  const completionValue = signUpUrl.searchParams.get("redirect_url");
  if (!completionValue) {
    throw new Error("Expected sign-up to retain its completion destination");
  }
  const completion = new URL(completionValue);
  expect(completion.pathname).toBe("/onboarding");
  expect(completion.searchParams.get("gclid")).toBe("click-123");
  expect(completion.searchParams.get("utm_campaign")).toBe("summer");

  click(signUp);

  await waitFor(() => {
    expect(pathname()).toBe("/sign-up");
  });
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(new URLSearchParams(search()).get("redirect_url")).toBe(
    completion.toString(),
  );
});

test("An explicit sign-up destination wins over campaign onboarding", async () => {
  const redirectUrl = "https://www.vm0.ai/connector/success";
  const path = `/sign-up?gclid=click-123&redirect_url=${encodeURIComponent(redirectUrl)}`;
  prepareAccountCreation();
  mockedClerk.signUpAttemptEmailAddressVerification.mockImplementation(() => {
    return moveSignUpToAsync({
      createdSessionId: "session_explicit_destination",
      hasPassword: true,
      status: "complete",
    });
  });
  await setupSignedOutPage(path);

  const codeInput = await advanceToEmailVerification();
  expect(codeInput).toBeEnabled();
  expect(location.search).toContain("gclid=click-123");
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    redirectUrl,
  );
  fireEvent.change(codeInput, { target: { value: "123456" } });
  const currentCodeInput = within(
    screen.getByRole("region", { name: "Verify your email" }),
  ).getByLabelText("Verification code");
  expect(currentCodeInput).toHaveValue("123456");
  fireEvent.submit(containingForm(currentCodeInput));

  await waitFor(() => {
    expect(location.href).toBe(redirectUrl);
  });
});

test("Sign-up campaign attribution survives verification and flow switches", async () => {
  const path =
    "/sign-up/verify-email-address?gclid=click-123&utm_campaign=summer&utm_content=hero&utm_content=footer#/verify?step=code";
  mockSignUpResource(readyVerificationState());
  mockSignInResource({ status: "needs_identifier" });
  preparePasswordSignIn();
  await setupSignedOutPage(path);

  await expect(
    screen.findByLabelText("Verification code"),
  ).resolves.toBeEnabled();
  click(await waitForRoleElement("button", "Edit email address"));

  await expect(screen.findByLabelText("Email address")).resolves.toHaveValue(
    "person@example.com",
  );
  const signIn = await waitForRoleElement("link", "Sign in");
  const signInUrl = new URL(signIn.getAttribute("href") ?? "", location.origin);
  expect(signInUrl.searchParams.get("gclid")).toBe("click-123");
  expect(signInUrl.searchParams.getAll("utm_content")).toStrictEqual([
    "hero",
    "footer",
  ]);
  expect(signInUrl.hash).toBe("#/verify?step=code");
  const completionValue = signInUrl.searchParams.get("redirect_url");
  if (!completionValue) {
    throw new Error("Expected campaign completion destination");
  }
  const completion = new URL(completionValue);
  expect(completion.pathname).toBe("/onboarding");
  expect(completion.searchParams.get("landing_host")).toBe("app.vm0.ai");
  expect(completion.searchParams.get("landing_path")).toBe(
    "/sign-up/verify-email-address",
  );

  click(signIn);
  await waitFor(() => {
    expect(pathname()).toBe("/sign-in");
  });
  await expect(
    screen.findByRole("region", { name: "Sign in to VM0" }),
  ).resolves.toBeVisible();
  await completePasswordSignIn();

  await waitFor(() => {
    expect(location.pathname).toBe("/onboarding");
  });
  const destination = new URL(location.href);
  expect(destination.searchParams.get("gclid")).toBe("click-123");
  expect(destination.searchParams.getAll("utm_content")).toStrictEqual([
    "hero",
    "footer",
  ]);
});

test("Okou sign-up preserves a trusted primary-app destination", async () => {
  const redirectUrl = "https://app.vm0.ai/agents?source=okou";
  prepareAccountCreation();
  await setupSignedOutPage(
    `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
    "app.okou.ai",
  );

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  const codeInput = await advanceToEmailVerification();

  expect(codeInput).toBeEnabled();
  expect(location.hostname).toBe("app.okou.ai");
  expect(
    screen.getByRole("region", { name: "Verify your email" }),
  ).toHaveAccessibleDescription(
    "Enter the verification code sent to your email",
  );
  expect(new URL(location.href).searchParams.get("redirect_url")).toBe(
    redirectUrl,
  );
});

test("A trusted Okou destination uses Okou authentication context", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-v2";
  mockSignInResource({ status: "needs_identifier" });
  preparePasswordSignIn();
  await setupSignedOutPage(
    `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`,
  );

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Sign in to Okou" }),
  ).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Sign in to Okou" }),
  ).toHaveAccessibleDescription("Welcome back! Please sign in to continue");
  expect(roleElement("link", "Go to Okou home")).toHaveAttribute(
    "href",
    "https://app.okou.ai",
  );

  await completePasswordSignIn();

  await waitFor(() => {
    expect(location.href).toBe(redirectUrl);
  });
});
