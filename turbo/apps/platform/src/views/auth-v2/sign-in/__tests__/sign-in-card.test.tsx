import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInResource,
  type MockedSignInFactor,
  type MockedSignInResourceState,
} from "../../../../__tests__/mock-auth.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../../signals/utils.ts";

const context = testContext();

function passwordFactor(): MockedSignInFactor {
  return { strategy: "password" };
}

function emailCodeFactor(): MockedSignInFactor {
  return {
    emailAddressId: "email_primary",
    safeIdentifier: "p***@example.com",
    strategy: "email_code",
  };
}

function passwordResetFactor(): MockedSignInFactor {
  return {
    emailAddressId: "email_primary",
    safeIdentifier: "p***@example.com",
    strategy: "reset_password_email_code",
  };
}

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
}

function setupSignInPage(state: MockedSignInResourceState): void {
  mockSignInResource(state);
  context.mocks.browser.url("https://app.vm0.ai/v2/sign-in");
  detachedSetupPage({
    context,
    path: "/v2/sign-in",
    session: null,
    user: null,
  });
}

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function roleElement(role: "button" | "link", name: string) {
  return queryAllByRoleFast(role).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function waitForRoleElement(
  role: "button" | "link",
  name: string,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(roleElement(role, name)).toBeDefined();
  });
  const element = roleElement(role, name);
  if (!element) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return element;
}

async function submitIdentifier(
  identifier: string,
  factors: readonly MockedSignInFactor[],
): Promise<void> {
  const identifierInput = await screen.findByLabelText(
    "Email address or username",
  );
  const nextResource = moveSignInTo({
    status: "needs_first_factor",
    supportedFirstFactors: factors,
  });
  mockedClerk.clientSignInCreate.mockResolvedValue(nextResource);
  fireEvent.change(identifierInput, { target: { value: identifier } });
  fireEvent.submit(containingForm(identifierInput));

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({ identifier });
  });
}

describe("auth v2 sign-in flow", () => {
  it("shows the loading state until the low-level Clerk resource is ready", async () => {
    const clerkLoad = createDeferredPromise<void>(context.signal);
    mockedClerk.load.mockImplementation(() => {
      return clerkLoad.promise;
    });

    setupSignInPage({ status: "needs_identifier" });

    const signInCard = await screen.findByTestId("app-auth-v2");
    const loadingState = within(signInCard).getByRole("status");
    expect(loadingState).toHaveTextContent("Loading authentication");

    await act(async () => {
      clerkLoad.resolve(undefined);
      await clerkLoad.promise;
    });

    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toBeVisible();
  });

  it("discovers password factors, coalesces duplicate submits, and activates once", async () => {
    const attempt = createDeferredPromise<
      ReturnType<typeof currentSignInResource>
    >(context.signal);
    mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
      return attempt.promise;
    });

    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", [passwordFactor()]);

    const passwordMethod = await waitForRoleElement(
      "button",
      "Sign in with your password",
    );
    fireEvent.click(passwordMethod);

    const passwordInput = await screen.findByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "correct-password" } });
    const passwordForm = containingForm(passwordInput);
    fireEvent.submit(passwordForm);
    fireEvent.submit(passwordForm);

    await waitFor(() => {
      expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledWith({
      password: "correct-password",
      strategy: "password",
    });

    await act(async () => {
      const resource = moveSignInTo({
        createdSessionId: "session_password",
        status: "complete",
      });
      attempt.resolve(resource);
      await attempt.promise;
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      redirectUrl: "/",
      session: "session_password",
    });
  });

  it("prepares and resends one email code per concurrent user action", async () => {
    const prepare = createDeferredPromise<
      ReturnType<typeof currentSignInResource>
    >(context.signal);
    const resend = createDeferredPromise<
      ReturnType<typeof currentSignInResource>
    >(context.signal);
    const attempt = createDeferredPromise<
      ReturnType<typeof currentSignInResource>
    >(context.signal);
    let prepareCalls = 0;
    mockedClerk.signInPrepareFirstFactor.mockImplementation(() => {
      prepareCalls += 1;
      return prepareCalls === 1 ? prepare.promise : resend.promise;
    });
    mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
      return attempt.promise;
    });

    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", [
      passwordFactor(),
      emailCodeFactor(),
    ]);

    const emailMethod = await waitForRoleElement(
      "button",
      "Email code to p***@example.com",
    );
    fireEvent.click(emailMethod);
    fireEvent.click(emailMethod);

    await waitFor(() => {
      expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenLastCalledWith({
      emailAddressId: "email_primary",
      strategy: "email_code",
    });

    await act(async () => {
      prepare.resolve(currentSignInResource());
      await prepare.promise;
    });

    const codeInput = await screen.findByLabelText("Verification code");
    const resendButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend",
    );
    fireEvent.click(resendButton);
    fireEvent.click(resendButton);

    await waitFor(() => {
      expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      resend.resolve(currentSignInResource());
      await resend.promise;
    });

    fireEvent.change(codeInput, { target: { value: "123456" } });
    const codeForm = containingForm(codeInput);
    fireEvent.submit(codeForm);
    fireEvent.submit(codeForm);

    await waitFor(() => {
      expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledWith({
      code: "123456",
      strategy: "email_code",
    });

    await act(async () => {
      const resource = moveSignInTo({
        createdSessionId: "session_email_code",
        status: "complete",
      });
      attempt.resolve(resource);
      await attempt.promise;
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
  });

  it("runs the password-reset code and new-password sequence", async () => {
    const factors = [passwordFactor(), passwordResetFactor()];
    mockedClerk.signInPrepareFirstFactor.mockResolvedValue(
      currentSignInResource(),
    );

    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", factors);

    fireEvent.click(await waitForRoleElement("button", "Reset your password"));
    await waitFor(() => {
      expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledWith({
        emailAddressId: "email_primary",
        strategy: "reset_password_email_code",
      });
    });

    const codeInput = await screen.findByLabelText("Verification code");
    fireEvent.change(codeInput, { target: { value: "654321" } });
    mockedClerk.signInAttemptFirstFactor.mockResolvedValue(
      moveSignInTo({
        status: "needs_new_password",
        supportedFirstFactors: factors,
      }),
    );
    fireEvent.submit(containingForm(codeInput));

    await waitFor(() => {
      expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledWith({
        code: "654321",
        strategy: "reset_password_email_code",
      });
    });

    const newPasswordInput = await screen.findByLabelText("New password");
    const confirmPasswordInput = screen.getByLabelText("Confirm password");
    fireEvent.change(newPasswordInput, { target: { value: "new-password" } });
    fireEvent.change(confirmPasswordInput, {
      target: { value: "different-password" },
    });
    fireEvent.submit(containingForm(newPasswordInput));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Passwords don't match.",
    );
    expect(mockedClerk.signInResetPassword).not.toHaveBeenCalled();

    fireEvent.change(confirmPasswordInput, {
      target: { value: "new-password" },
    });
    mockedClerk.signInResetPassword.mockResolvedValue(
      moveSignInTo({
        createdSessionId: "session_reset",
        status: "complete",
      }),
    );
    fireEvent.submit(containingForm(newPasswordInput));

    await waitFor(() => {
      expect(mockedClerk.signInResetPassword).toHaveBeenCalledWith({
        password: "new-password",
      });
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps an incomplete step usable after a Clerk API error", async () => {
    mockedClerk.clientSignInCreate.mockRejectedValue({
      errors: [
        {
          longMessage: "We couldn't find an account with that identifier.",
          meta: { paramName: "identifier" },
        },
      ],
    });

    setupSignInPage({ status: "needs_identifier" });

    const identifierInput = await screen.findByLabelText(
      "Email address or username",
    );
    fireEvent.change(identifierInput, {
      target: { value: "missing@example.com" },
    });
    fireEvent.submit(containingForm(identifierInput));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "We couldn't find an account with that identifier.",
    );
    expect(identifierInput).toBeVisible();
  });

  it("renders a transfer state without implementing sign-up", async () => {
    setupSignInPage({
      isTransferable: true,
      status: "needs_identifier",
    });

    const signUp = await waitForRoleElement("link", "Sign up");
    expect(signUp).toHaveAttribute("href", "/v2/sign-up");
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "an unsupported Clerk status",
      state: { status: "needs_second_factor" },
    },
    {
      name: "an unsupported factor set",
      state: {
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "oauth_google" }],
      },
    },
    {
      name: "a completed attempt without a session",
      state: { status: "complete" },
    },
  ])("renders an explicit recovery surface for $name", async ({ state }) => {
    setupSignInPage(state);

    await expect(
      screen.findByRole("heading", { name: "Cannot sign in" }),
    ).resolves.toBeVisible();
    await expect(
      waitForRoleElement("button", "Use another method"),
    ).resolves.toBeVisible();
  });
});
