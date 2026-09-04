import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  mockAuthV2Capabilities,
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
  type MockedSignInResourceState,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pushState } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
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

test("Google sign-up callback failure returns a safe error", async () => {
  mockAuthV2Capabilities({ googleOAuth: true });
  mockSignUpResource({
    externalAccountError: {
      code: "oauth_callback_error",
      longMessage: "Google sign-up was cancelled for private@example.com.",
      message: "OAuth callback failed",
    },
    externalAccountStatus: "failed",
    status: null,
  });

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-up/sso-callback",
    auth: null,
  });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(alert).not.toHaveTextContent("private@example.com");
  click(await waitForRoleElement("button", "Continue with Google"));
  await waitFor(() => {
    expect(mockedClerk.signUpAuthenticateWithRedirect).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});

test("A completed Google sign-up recovers after refresh", async () => {
  mockSignUpResource({
    createdSessionId: "session_google_sign_up",
    externalAccountStatus: "verified",
    status: "complete",
  });

  await setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-up/sso-callback?gclid=click-123&utm_campaign=summer",
    auth: null,
  });

  await waitFor(() => {
    expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(1);
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_google_sign_up",
    });
  });
  expect(mockedClerk.handleRedirectCallback).not.toHaveBeenCalled();
  expect(location.pathname).toBe("/onboarding");
  expect(new URL(location.href).searchParams.get("gclid")).toBe("click-123");
});

test("Google sign-up with an existing account resumes the required sign-in step", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const transfer =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockedClerk.clientSignInCreate.mockReturnValueOnce(transfer.promise);
  mockSignUpResource({
    externalAccountError: {
      code: "external_account_exists",
      message: "Account already exists",
    },
    externalAccountStatus: "transferable",
    isTransferable: true,
    status: "missing_requirements",
  });
  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-up/sso-callback?utm_campaign=existing-account",
    auth: null,
  });

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      transfer: true,
    });
  });
  transfer.resolve(
    moveSignInTo({
      status: "needs_second_factor",
      supportedSecondFactors: [
        {
          emailAddressId: "email_primary",
          safeIdentifier: "p***@example.com",
          strategy: "email_code",
        },
      ],
    }),
  );
  await pageReady;

  await waitFor(() => {
    expect(assigned.calls).toHaveLength(1);
  });
  const destination = new URL(assigned.calls[0] ?? "", location.origin);
  expect(destination.pathname).toBe("/sign-in/factor-two");
  expect(destination.searchParams.get("utm_campaign")).toBe("existing-account");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});

test("An existing Google identity transfers only once across callback recovery", async () => {
  mockSignUpResource({
    emailAddress: "person@example.com",
    externalAccountError: {
      code: "external_account_exists",
      message: "Account already exists",
    },
    externalAccountStatus: "transferable",
    isTransferable: true,
    status: "missing_requirements",
  });
  const transfer =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockedClerk.clientSignInCreate.mockReturnValueOnce(transfer.promise);
  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/sign-up/sso-callback?utm_campaign=transfer-once",
    auth: null,
  });

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
  });
  transfer.resolve(
    moveSignInTo({
      createdSessionId: "session_existing_identity",
      identifier: "person@example.com",
      status: "complete",
    }),
  );
  await pageReady;
  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_existing_identity",
    });
    expect(location.pathname).toBe("/onboarding");
  });

  pushState(null, "", "/sign-up/sso-callback?utm_campaign=transfer-once");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => {
    expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(2);
  });

  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
    transfer: true,
  });
  expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(2);
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(2);
});

test("An incomplete existing Google account returns to sign-in", async () => {
  const assigned = context.mocks.browser.locationAssign();
  const transfer =
    context.mocks.deferred<ReturnType<typeof currentSignInResource>>();
  mockedClerk.clientSignInCreate.mockReturnValueOnce(transfer.promise);
  mockSignUpResource({
    externalAccountError: {
      code: "external_account_exists",
      message: "Account already exists",
    },
    externalAccountStatus: "transferable",
    isTransferable: true,
    status: "missing_requirements",
  });
  const redirectUrl = "https://app.okou.ai/onboarding?source=transfer";

  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: `/sign-up/sso-callback?utm_campaign=transfer&redirect_url=${encodeURIComponent(
      redirectUrl,
    )}#/callback?attempt=1`,
    auth: null,
  });

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
  });
  transfer.resolve(
    moveSignInTo({
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    }),
  );
  await pageReady;
  await waitFor(() => {
    expect(assigned.calls).toHaveLength(1);
  });
  const destination = new URL(assigned.calls[0] ?? "", location.origin);
  expect(destination.pathname).toBe("/sign-in/factor-one");
  expect(destination.searchParams.get("redirect_url")).toBe(redirectUrl);
  expect(destination.searchParams.get("utm_campaign")).toBe("transfer");
  expect(destination.hash).toBe("#/callback?attempt=1");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});
