// @vitest-environment-options {"url":"https://app.vm0.ai/"}

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  mockAuthV2Capabilities,
  mockedClerk,
  mockedGoogleOneTap,
  mockGoogleOneTapCredential,
  mockSignInResource,
  mockSignUpConfiguration,
  mockSignUpResource,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pushState } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CREDENTIAL = "private-google-one-tap-credential";

function setupOneTap(path = "/sign-in"): Promise<void> {
  context.mocks.browser.fedCm();
  context.mocks.posthog();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential(CREDENTIAL);
  mockSignInResource({ status: "needs_identifier" });
  return setupPage({
    auth: null,
    context,
    env: { VITE_POSTHOG_KEY: "phc_platform_test" },
    host: "app.vm0.ai",
    path,
  });
}

function rejectMissingAccount(): void {
  mockedClerk.clientSignInCreate.mockRejectedValueOnce({
    errors: [{ code: "external_account_not_found" }],
  });
}

function diagnosticEvents() {
  return context.mocks.posthog().events.filter(({ name }) => {
    return name === "auth_v2_diagnostic";
  });
}

function getContinueButton(): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Continue";
  });
  if (!button) {
    throw new Error("Expected the sign-up Continue button");
  }
  return button;
}

async function followNavigation(href: string): Promise<void> {
  await act(async () => {
    pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await Promise.resolve();
  });
}

test("A new One Tap account resumes sign-up and requires explicit legal consent", async () => {
  const user = userEvent.setup({ delay: null });
  const assigned = context.mocks.browser.locationAssign();
  rejectMissingAccount();
  mockSignUpConfiguration({
    legalConsentEnabled: true,
    privacyPolicyUrl: "https://vm0.ai/legal/privacy",
    termsUrl: "https://vm0.ai/legal/terms",
  });
  mockedClerk.clientSignUpCreate.mockImplementationOnce(() => {
    mockSignUpResource({
      emailAddress: "person@example.com",
      externalAccountStatus: "verified",
      missingFields: ["legal_accepted"],
      requiredFields: ["legal_accepted"],
      status: "missing_requirements",
    });
    return Promise.resolve(mockedClerk.client.signUp);
  });
  mockedClerk.signUpUpdate.mockImplementationOnce(() => {
    mockSignUpResource({
      createdSessionId: "session_one_tap_sign_up",
      legalAcceptedAt: 1,
      status: "complete",
    });
    return Promise.resolve(mockedClerk.client.signUp);
  });

  await setupOneTap("/sign-in?utm_campaign=one-tap&gclid=click-123");
  await waitFor(() => {
    expect(assigned.calls).toHaveLength(1);
  });
  const href = assigned.calls[0] ?? "";
  const target = new URL(href, location.origin);
  expect(target.pathname).toBe("/sign-up");
  expect(target.searchParams.get("utm_campaign")).toBe("one-tap");
  expect(target.searchParams.get("gclid")).toBe("click-123");
  expect(href).not.toContain(CREDENTIAL);
  expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledWith({
    strategy: "google_one_tap",
    token: CREDENTIAL,
  });
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(diagnosticEvents()).toContainEqual({
      name: "auth_v2_diagnostic",
      properties: expect.objectContaining({
        flow: "sign-up",
        method: "google-one-tap",
        outcome: "success",
        step: "one-tap-sign-up",
      }),
    });
  });
  expect(JSON.stringify(diagnosticEvents())).not.toContain(CREDENTIAL);

  await followNavigation(href);
  const legalConsent = await screen.findByRole("checkbox");
  expect(legalConsent).not.toBeChecked();
  const form = legalConsent.closest("form");
  if (!form) {
    throw new Error("Expected sign-up consent inside a form");
  }
  fireEvent.submit(form);
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(mockedClerk.signUpUpdate).not.toHaveBeenCalled();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();

  await user.click(legalConsent);
  await waitFor(() => {
    expect(legalConsent).toBeChecked();
  });
  click(getContinueButton());
  await waitFor(() => {
    expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signUpUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ legalAccepted: true }),
  );
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  expect(new URL(location.href).searchParams.get("gclid")).toBe("click-123");
});

test("A completed One Tap sign-up activates through sign-up continuation", async () => {
  const assigned = context.mocks.browser.locationAssign();
  rejectMissingAccount();
  mockedClerk.clientSignUpCreate.mockImplementationOnce(() => {
    mockSignUpResource({
      createdSessionId: "session_one_tap_complete",
      status: "complete",
    });
    return Promise.resolve(mockedClerk.client.signUp);
  });

  await setupOneTap();
  await waitFor(() => {
    expect(assigned.calls).toHaveLength(1);
  });
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await followNavigation(assigned.calls[0] ?? "");
  await waitFor(() => {
    expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  expect(mockedClerk.setActive).toHaveBeenCalledWith({
    navigate: expect.any(Function),
    session: "session_one_tap_complete",
  });
});

test("Unrelated One Tap exchange errors retain ordinary sign-in and private diagnostics", async () => {
  const assigned = context.mocks.browser.locationAssign();
  mockedClerk.clientSignInCreate.mockRejectedValueOnce({
    errors: [
      {
        code: "private_provider_code",
        message: "Private details for person@example.com",
      },
    ],
  });

  await setupOneTap();
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(screen.getByLabelText("Email address")).toBeEnabled();
  expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();
  expect(assigned.calls).toHaveLength(0);
  await waitFor(() => {
    expect(diagnosticEvents()).toContainEqual({
      name: "auth_v2_diagnostic",
      properties: expect.objectContaining({
        error_category: "provider-error",
        outcome: "failure",
        step: "one-tap-exchange",
      }),
    });
  });
  const serialized = JSON.stringify(diagnosticEvents());
  expect(serialized).not.toContain(CREDENTIAL);
  expect(serialized).not.toContain("private_provider_code");
  expect(serialized).not.toContain("person@example.com");
});

test("A rejected One Tap sign-up remains recoverable and identifies the failed stage", async () => {
  const assigned = context.mocks.browser.locationAssign();
  rejectMissingAccount();
  mockedClerk.clientSignUpCreate.mockRejectedValueOnce({
    errors: [{ code: "not_allowed_access" }],
  });

  await setupOneTap();
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(screen.getByLabelText("Email address")).toBeEnabled();
  expect(assigned.calls).toHaveLength(0);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(diagnosticEvents()).toContainEqual({
      name: "auth_v2_diagnostic",
      properties: expect.objectContaining({
        flow: "sign-up",
        outcome: "failure",
        step: "one-tap-sign-up",
      }),
    });
  });
});

test("Leaving during One Tap sign-up prevents a late redirect and duplicate credential exchange", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const pendingSignUp =
    context.mocks.deferred<typeof mockedClerk.client.signUp>();
  rejectMissingAccount();
  mockedClerk.clientSignUpCreate.mockReturnValueOnce(pendingSignUp.promise);

  await setupOneTap();
  await screen.findByLabelText("Email address");
  await waitFor(() => {
    expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(1);
  });
  const googleCallback =
    mockedGoogleOneTap.initialize.mock.calls[0]?.[0].callback;
  act(() => {
    googleCallback?.({ credential: CREDENTIAL });
  });
  await followNavigation("/sign-up");
  await screen.findByRole("region", { name: "Create your account" });
  await act(async () => {
    pendingSignUp.resolve(mockedClerk.client.signUp);
    await pendingSignUp.promise;
  });
  expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(1);
  expect(assigned.calls).toHaveLength(0);
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});
