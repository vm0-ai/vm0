import type { PasswordValidation } from "@clerk/react/types";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import { mockNow, now } from "../../../../lib/time.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../../__tests__/page-helper.ts";
import {
  mockAuthV2Capabilities,
  mockedClerk,
  mockSignInResource,
  mockSignUpConfiguration,
  mockSignUpPasswordValidation,
  mockSignUpResource,
  type MockedSignUpResourceState,
} from "../../../../__tests__/mock-auth.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { AUTH_V2_SIGN_UP_RESEND_COOLDOWN_STORAGE_KEY } from "../../../../signals/auth-v2/resend-cooldown.ts";
import { sessionStorageSignals } from "../../../../signals/external/session-storage.ts";
import { createDeferredPromise } from "../../../../signals/utils.ts";
import { renderedCheckboxPresentation } from "../../__tests__/auth-v2-style-assertions.ts";

const context = testContext();
const signUpResendCooldownStorage = sessionStorageSignals(
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_STORAGE_KEY,
);

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

function setupSignUpPage(
  state: MockedSignUpResourceState,
  options: { readonly path?: string; readonly url?: string } = {},
): void {
  const path = options.path ?? "/sign-up";
  mockSignUpResource(state);
  context.mocks.browser.url(options.url ?? `https://app.vm0.ai${path}`);
  detachedSetupPage({
    context,
    path,
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
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
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

function readyEmailVerificationState(
  overrides: Partial<MockedSignUpResourceState> = {},
): MockedSignUpResourceState {
  return {
    emailAddress: "person@example.com",
    emailVerificationExpireAt: new Date(now() + 10 * 60 * 1000),
    emailVerificationStatus: "unverified",
    emailVerificationStrategy: "email_code",
    hasPassword: true,
    missingFields: [],
    status: "missing_requirements",
    unverifiedFields: ["email_address"],
    ...overrides,
  };
}

async function fillRequiredDetails(): Promise<{
  readonly emailInput: HTMLElement;
  readonly passwordInput: HTMLElement;
}> {
  const emailInput = await screen.findByLabelText("Email address");
  const passwordInput = screen.getByLabelText("Password");
  fireEvent.change(emailInput, { target: { value: "person@example.com" } });
  fireEvent.change(passwordInput, { target: { value: "valid-password" } });
  return { emailInput, passwordInput };
}

describe("auth v2 sign-up flow", () => {
  it("shows loading on the base route until the low-level Clerk resource is ready", async () => {
    const clerkLoad = createDeferredPromise<void>(context.signal);
    mockedClerk.load.mockImplementation(() => {
      return clerkLoad.promise;
    });

    setupSignUpPage({ status: null });

    const signUpCard = await screen.findByTestId("app-auth-v2");
    expect(within(signUpCard).getByRole("status")).toHaveTextContent(
      "Checking what your account needs next.",
    );

    await act(async () => {
      clerkLoad.resolve(undefined);
      await clerkLoad.promise;
    });

    await expect(
      screen.findByLabelText("Email address"),
    ).resolves.toBeVisible();
  });

  it("renders pristine Clerk environment requirements without mutating the sign-up resource", async () => {
    mockSignUpConfiguration({
      attributes: {
        email_address: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
        },
        first_name: {
          enabled: true,
          required: false,
          used_for_first_factor: false,
        },
        last_name: {
          enabled: true,
          required: false,
          used_for_first_factor: false,
        },
        password: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
        },
      },
      captchaEnabled: true,
      legalConsentEnabled: true,
      privacyPolicyUrl: "https://vm0.ai/legal/privacy",
      progressive: true,
      termsUrl: "https://vm0.ai/legal/terms",
    });
    setupSignUpPage({
      missingFields: [],
      optionalFields: [],
      requiredFields: [],
      status: null,
    });

    const emailInput = await screen.findByLabelText("Email address");
    const passwordInput = screen.getByLabelText("Password");
    expect(emailInput).toBeRequired();
    expect(passwordInput).toBeRequired();
    expect(emailInput).toHaveAttribute(
      "placeholder",
      "Enter your email address",
    );
    expect(passwordInput).toHaveAttribute("placeholder", "Create a password");
    expect(screen.queryByLabelText(/First name/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Last name/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Create your account" }),
    ).toBeVisible();
    const signIn = await waitForRoleElement("link", "Sign in");
    expect(
      screen.getByRole("region", { name: "Create your account" }),
    ).toContainElement(signIn);
    expect(signIn.getAttribute("href")).toMatch(/^\/sign-in(?:[?#]|$)/);
    const legalConsent = screen.getByRole("checkbox");
    expect(legalConsent).toBeVisible();
    await expect(
      renderedCheckboxPresentation(legalConsent, context.signal),
    ).resolves.toStrictEqual({
      backgroundColor: "rgb(40 50 60)",
      borderColor: "rgb(10 20 30)",
      borderRadius: "6px",
      borderStyle: "solid",
      borderWidth: "1px",
      flexShrink: "0",
      height: "calc(4px * 4)",
      width: "calc(4px * 4)",
    });
    expect(roleElement("link", "Terms of Service")).toHaveAttribute(
      "href",
      "https://vm0.ai/legal/terms",
    );
    expect(roleElement("link", "Privacy Policy")).toHaveAttribute(
      "href",
      "https://vm0.ai/legal/privacy",
    );
    expect(document.querySelector("#clerk-captcha")).toBeInTheDocument();
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();
    expect(mockedClerk.signUpUpdate).not.toHaveBeenCalled();
    expect(
      mockedClerk.signUpPrepareEmailAddressVerification,
    ).not.toHaveBeenCalled();
    expect(
      mockedClerk.signUpAttemptEmailAddressVerification,
    ).not.toHaveBeenCalled();
  });

  it("keeps restored resource requirements ahead of current environment settings", async () => {
    mockSignUpConfiguration({
      attributes: {
        first_name: {
          enabled: true,
          required: true,
          used_for_first_factor: false,
        },
        last_name: {
          enabled: false,
          required: false,
          used_for_first_factor: false,
        },
        phone_number: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
        },
      },
      legalConsentEnabled: true,
    });
    setupSignUpPage(
      readyEmailVerificationState({
        optionalFields: ["first_name", "last_name"],
        requiredFields: ["email_address", "password"],
      }),
    );

    await expect(
      screen.findByLabelText("Verification code"),
    ).resolves.toBeVisible();
    expect(roleElement("link", "Sign in")).toBeUndefined();
    expect(screen.queryByText("Access restricted")).not.toBeInTheDocument();
    expect(
      mockedClerk.signUpPrepareEmailAddressVerification,
    ).not.toHaveBeenCalled();

    fireEvent.click(await waitForRoleElement("button", "Edit email address"));
    await expect(
      screen.findByLabelText("Email address"),
    ).resolves.toBeRequired();
    expect(roleElement("link", "Sign in")).toBeDefined();
    expect(screen.queryByLabelText(/First name/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Last name/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("fails closed for a required unsupported pristine attribute", async () => {
    mockSignUpConfiguration({
      attributes: {
        phone_number: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
        },
      },
    });
    setupSignUpPage({
      missingFields: [],
      optionalFields: [],
      requiredFields: [],
      status: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Access restricted" }),
    ).resolves.toBeVisible();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();
    expect(mockedClerk.signUpUpdate).not.toHaveBeenCalled();
    expect(
      mockedClerk.signUpPrepareEmailAddressVerification,
    ).not.toHaveBeenCalled();
  });

  it("hides Google when the current Clerk environment does not support it", async () => {
    setupSignUpPage({ status: null });

    await screen.findByLabelText("Email address");
    expect(roleElement("button", "Continue with Google")).toBeUndefined();
    expect(
      document.querySelector("script[data-auth-v2-google-one-tap]"),
    ).not.toBeInTheDocument();
  });

  it("shows configured Apple and Google sign-up with compact provider labels", async () => {
    mockAuthV2Capabilities({ appleOAuth: true, googleOAuth: true });
    setupSignUpPage({ status: null });

    const apple = await waitForRoleElement("button", "Continue with Apple");
    const google = await waitForRoleElement("button", "Continue with Google");
    expect(apple).toBeVisible();
    expect(google).toBeVisible();
    expect(apple.textContent?.trim()).toBe("Apple");
    expect(google.textContent?.trim()).toBe("Google");
    expect(
      document.querySelector("script[data-auth-v2-google-one-tap]"),
    ).not.toBeInTheDocument();
  });

  it.each([
    { competingProvider: "Google", provider: "Apple", strategy: "oauth_apple" },
    {
      competingProvider: "Apple",
      provider: "Google",
      strategy: "oauth_google",
    },
  ] as const)(
    "coalesces $provider handoff and preserves safe campaign attribution",
    async ({ competingProvider, provider, strategy }) => {
      const redirect = createDeferredPromise<void>(context.signal);
      mockedClerk.signUpAuthenticateWithRedirect.mockImplementation(() => {
        return redirect.promise;
      });
      mockAuthV2Capabilities({ appleOAuth: true, googleOAuth: true });
      const untrustedRedirect = "https://app.okou.ai.evil.example/steal";
      const path = `/sign-up?gclid=click-123&utm_campaign=summer&redirect_url=${encodeURIComponent(untrustedRedirect)}#/start?step=oauth`;
      setupSignUpPage(
        { status: null },
        {
          path,
          url: `https://app.vm0.ai${path}`,
        },
      );

      const selected = await waitForRoleElement(
        "button",
        `Continue with ${provider}`,
      );
      const competing = await waitForRoleElement(
        "button",
        `Continue with ${competingProvider}`,
      );
      fireEvent.click(selected);
      fireEvent.click(selected);

      await waitFor(() => {
        expect(
          mockedClerk.signUpAuthenticateWithRedirect,
        ).toHaveBeenCalledTimes(1);
        expect(selected).toHaveAttribute("aria-busy", "true");
      });
      expect(selected).toHaveAccessibleName(`Continue with ${provider}`);
      expect(selected.textContent?.trim()).toBe("");
      expect(competing).toBeDisabled();
      expect(competing).toHaveAttribute("aria-busy", "false");
      expect(competing.textContent?.trim()).toBe(competingProvider);
      const handoff =
        mockedClerk.signUpAuthenticateWithRedirect.mock.calls[0]?.[0];
      expect(handoff).toMatchObject({
        continueSignUp: false,
        strategy,
      });
      expect(handoff).not.toHaveProperty("continueSignIn");
      const callbackUrl = new URL(handoff?.redirectUrl ?? "", location.origin);
      const completionUrl = new URL(handoff?.redirectUrlComplete ?? "");
      expect(callbackUrl.pathname).toBe("/sign-up/sso-callback");
      expect(callbackUrl.searchParams.get("redirect_url")).toBe(
        completionUrl.toString(),
      );
      expect(callbackUrl.hash).toBe("#/start?step=oauth");
      expect(completionUrl.origin).toBe("https://app.vm0.ai");
      expect(completionUrl.pathname).toBe("/onboarding");
      expect(completionUrl.searchParams.get("gclid")).toBe("click-123");
      expect(completionUrl.searchParams.get("utm_campaign")).toBe("summer");
      expect(completionUrl.toString()).not.toContain("evil.example");

      await act(async () => {
        redirect.resolve(undefined);
        await redirect.promise;
      });
      await waitFor(() => {
        expect(selected).toHaveAttribute("aria-busy", "false");
        expect(selected).toHaveTextContent(provider);
      });
    },
  );

  it("requires legal consent before Google handoff and forwards acceptance", async () => {
    const user = userEvent.setup();
    mockAuthV2Capabilities({ googleOAuth: true });
    setupSignUpPage({
      missingFields: ["email_address", "password", "legal_accepted"],
      requiredFields: ["email_address", "password", "legal_accepted"],
      status: null,
    });

    const google = await waitForRoleElement("button", "Continue with Google");
    await user.click(google);
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Please read and accept the terms to continue",
    );
    expect(mockedClerk.signUpAuthenticateWithRedirect).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox"));
    await user.click(google);
    await waitFor(() => {
      expect(mockedClerk.signUpAuthenticateWithRedirect).toHaveBeenCalledWith(
        expect.objectContaining({ legalAccepted: true }),
      );
    });
  });

  it("hands a completed Google callback to continuation exactly once", async () => {
    const path = "/sign-up/sso-callback?gclid=click-123&utm_campaign=summer";
    setupSignUpPage(
      {
        createdSessionId: "session_google_sign_up",
        externalAccountStatus: "verified",
        status: "complete",
      },
      { path, url: `https://app.vm0.ai${path}` },
    );

    await waitFor(() => {
      expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(1);
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.handleRedirectCallback).not.toHaveBeenCalled();
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_google_sign_up",
    });
    const redirectUrl = new URL(location.href);
    expect(redirectUrl.pathname).toBe("/onboarding");
    expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
    expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
  });

  it("transfers an existing Google identity and activates it once through the same completion seam", async () => {
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        createdSessionId: "session_existing_google",
        status: "complete",
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });
    const path =
      "/sign-up/sso-callback?gclid=existing-123&utm_campaign=transfer";
    setupSignUpPage(
      {
        externalAccountError: {
          code: "external_account_exists",
          message: "Account already exists",
        },
        externalAccountStatus: "transferable",
        isTransferable: true,
        status: "missing_requirements",
      },
      { path, url: `https://app.vm0.ai${path}` },
    );

    await waitFor(() => {
      expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      transfer: true,
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_existing_google",
    });
    const redirectUrl = new URL(location.href);
    expect(redirectUrl.pathname).toBe("/onboarding");
    expect(redirectUrl.searchParams.get("gclid")).toBe("existing-123");
    expect(redirectUrl.searchParams.get("utm_campaign")).toBe("transfer");
  });

  it("reuses an in-progress transfer on callback reload without another transfer operation", async () => {
    mockSignInResource({
      createdSessionId: "session_recovered_transfer",
      identifier: "person@example.com",
      status: "complete",
    });
    setupSignUpPage(
      {
        emailAddress: "person@example.com",
        externalAccountError: {
          code: "external_account_exists",
          message: "Account already exists",
        },
        externalAccountStatus: "transferable",
        isTransferable: true,
        status: "missing_requirements",
      },
      {
        path: "/sign-up/sso-callback",
        url: "https://app.vm0.ai/sign-up/sso-callback",
      },
    );

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_recovered_transfer",
    });
    expect(location.origin).toBe("https://app.vm0.ai");
    expect(location.pathname).toBe("/onboarding");
  });

  it("replaces an unrelated sign-in resource before transferring an existing Google identity", async () => {
    mockSignInResource({
      createdSessionId: "session_unrelated",
      identifier: "other@example.com",
      status: "complete",
    });
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        createdSessionId: "session_existing_google",
        identifier: "person@example.com",
        status: "complete",
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });
    setupSignUpPage(
      {
        emailAddress: "person@example.com",
        externalAccountError: {
          code: "external_account_exists",
          message: "Account already exists",
        },
        externalAccountStatus: "transferable",
        isTransferable: true,
        status: "missing_requirements",
      },
      {
        path: "/sign-up/sso-callback",
        url: "https://app.vm0.ai/sign-up/sso-callback",
      },
    );

    await waitFor(() => {
      expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
        transfer: true,
      });
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        navigate: expect.any(Function),
        session: "session_existing_google",
      });
    });
    expect(mockedClerk.setActive).not.toHaveBeenCalledWith(
      expect.objectContaining({ session: "session_unrelated" }),
    );
  });

  it("hands an incomplete existing-identity transfer to the attributed v2 sign-in step", async () => {
    const assigned = context.mocks.browser.locationAssign();
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });
    const redirectUrl = "https://app.okou.ai/onboarding?source=transfer";
    const path = `/sign-up/sso-callback?utm_campaign=transfer&redirect_url=${encodeURIComponent(redirectUrl)}#/callback?attempt=1`;
    setupSignUpPage(
      {
        externalAccountError: {
          code: "external_account_exists",
          message: "Account already exists",
        },
        externalAccountStatus: "transferable",
        isTransferable: true,
        status: "missing_requirements",
      },
      { path, url: `https://app.vm0.ai${path}` },
    );

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

  it("surfaces a cancelled Google callback and leaves sign-up retryable", async () => {
    mockAuthV2Capabilities({ googleOAuth: true });
    setupSignUpPage(
      {
        externalAccountError: {
          code: "oauth_callback_error",
          longMessage: "Google sign-up was cancelled.",
          message: "OAuth callback failed",
        },
        externalAccountStatus: "failed",
        status: null,
      },
      {
        path: "/sign-up/sso-callback",
        url: "https://app.vm0.ai/sign-up/sso-callback",
      },
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This action couldn't be completed. Please try again later or contact support if this persists.",
    );
    expect(document.activeElement).toBe(alert);
    expect(screen.queryByText("Google sign-up was cancelled.")).toBeNull();
    fireEvent.click(await waitForRoleElement("button", "Continue with Google"));
    await waitFor(() => {
      expect(mockedClerk.signUpAuthenticateWithRedirect).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
  });

  it("recovers a prepared progressive sign-up on a nested refresh without sending another code", async () => {
    const startedAt = Date.parse("2026-08-25T08:00:00.000Z");
    mockNow(startedAt + 1000, context.signal);
    context.store.set(
      signUpResendCooldownStorage.set$,
      JSON.stringify({
        deadlineMs: startedAt + 30_000,
        identity: "person@example.com",
      }),
    );
    setupSignUpPage(readyEmailVerificationState(), {
      path: "/sign-up/verify-email-address",
    });

    await expect(
      screen.findByLabelText("Verification code"),
    ).resolves.toBeVisible();
    await expect(
      waitForRoleElement("button", "Didn't receive a code? Resend (29)"),
    ).resolves.toBeDisabled();
    expect(
      mockedClerk.signUpPrepareEmailAddressVerification,
    ).not.toHaveBeenCalled();
    expect(screen.getByText("person@example.com")).toBeVisible();
  });

  it("reveals the sign-up password by keyboard without submitting", async () => {
    const user = userEvent.setup({ delay: null });
    setupSignUpPage({ status: null });

    const passwordInput = await screen.findByLabelText("Password");
    const reveal = await waitForRoleElement("button", "Show password");
    expect(reveal).toHaveAttribute("aria-controls", passwordInput.id);
    expect(reveal).toHaveAttribute("aria-pressed", "false");
    expect(passwordInput).toHaveAttribute("type", "password");

    reveal.focus();
    await user.keyboard("{Enter}");
    expect(passwordInput).toHaveAttribute("type", "text");
    await expect(
      waitForRoleElement("button", "Hide password"),
    ).resolves.toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(passwordInput).toHaveAttribute("type", "password");
    expect(mockedClerk.signUpValidatePassword).not.toHaveBeenCalled();
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();
  });

  it("collects Clerk-exposed fields, validates the password, coalesces creation, and prepares exactly once", async () => {
    const create = createDeferredPromise<
      ReturnType<typeof currentSignUpResource>
    >(context.signal);
    mockedClerk.clientSignUpCreate.mockImplementation(() => {
      return create.promise;
    });
    mockedClerk.signUpPrepareEmailAddressVerification.mockImplementation(() => {
      return moveSignUpToAsync(readyEmailVerificationState());
    });

    mockSignUpConfiguration({
      attributes: {
        first_name: {
          enabled: true,
          required: true,
          used_for_first_factor: false,
        },
        last_name: {
          enabled: true,
          required: true,
          used_for_first_factor: false,
        },
      },
    });
    setupSignUpPage({ status: null });
    const { emailInput } = await fillRequiredDetails();
    const firstNameInput = screen.getByLabelText(/First name/);
    const lastNameInput = screen.getByLabelText(/Last name/);
    fireEvent.change(firstNameInput, { target: { value: "Ada" } });
    fireEvent.change(lastNameInput, { target: { value: "Lovelace" } });
    const form = containingForm(emailInput);
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.signUpValidatePassword).toHaveBeenCalledWith(
      "valid-password",
      expect.objectContaining({ onValidation: expect.any(Function) }),
    );
    expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledWith({
      emailAddress: "person@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      locale: "en-US",
      password: "valid-password",
    });

    await act(async () => {
      create.resolve(
        moveSignUpTo(
          readyEmailVerificationState({
            emailVerificationExpireAt: null,
            emailVerificationStatus: null,
            emailVerificationStrategy: null,
          }),
        ),
      );
      await create.promise;
    });

    await waitFor(() => {
      expect(
        mockedClerk.signUpPrepareEmailAddressVerification,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      mockedClerk.signUpPrepareEmailAddressVerification,
    ).toHaveBeenCalledWith({ strategy: "email_code" });
    await expect(
      screen.findByLabelText("Verification code"),
    ).resolves.toBeVisible();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", {
        level: 1,
        name: "Verify your email",
      }),
    );
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("coalesces resend and code attempts, applies cooldown, preserves attribution, and activates once", async () => {
    const startedAt = Date.parse("2026-08-25T08:00:00.000Z");
    mockNow(startedAt, context.signal);
    const resend = createDeferredPromise<
      ReturnType<typeof currentSignUpResource>
    >(context.signal);
    const attempt = createDeferredPromise<
      ReturnType<typeof currentSignUpResource>
    >(context.signal);
    mockedClerk.signUpPrepareEmailAddressVerification.mockImplementation(() => {
      return resend.promise;
    });
    mockedClerk.signUpAttemptEmailAddressVerification.mockImplementation(() => {
      return attempt.promise;
    });
    const path =
      "/sign-up/verify-email-address?gclid=click-123&utm_campaign=summer";
    setupSignUpPage(readyEmailVerificationState(), {
      path,
      url: `https://app.vm0.ai${path}`,
    });

    await screen.findByLabelText("Verification code");
    const resendButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend",
    );
    fireEvent.click(resendButton);
    fireEvent.click(resendButton);

    await waitFor(() => {
      expect(
        mockedClerk.signUpPrepareEmailAddressVerification,
      ).toHaveBeenCalledTimes(1);
      expect(resendButton).toHaveAttribute("aria-busy", "true");
    });
    expect(resendButton).toHaveAccessibleName("Didn't receive a code? Resend");
    expect(resendButton.textContent?.trim()).toBe("");
    expect(screen.getByLabelText("Verification code")).toBeVisible();
    expect(
      within(containingForm(resendButton)).queryByRole("status"),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);

    await act(async () => {
      resend.resolve(moveSignUpTo(readyEmailVerificationState()));
      await resend.promise;
    });

    const cooldownButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend (30)",
    );
    expect(cooldownButton).toBeDisabled();
    expect(context.store.get(signUpResendCooldownStorage.get$)).toBe(
      JSON.stringify({
        deadlineMs: startedAt + 30_000,
        identity: "person@example.com",
      }),
    );
    mockNow(startedAt + 1000, context.signal);
    const advancingCooldownButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend (29)",
    );
    expect(advancingCooldownButton).toBeDisabled();
    const readyCodeInput = await screen.findByLabelText("Verification code");
    expect(readyCodeInput).toHaveAttribute("autocomplete", "one-time-code");
    expect(readyCodeInput).toHaveAttribute("inputmode", "numeric");
    expect(readyCodeInput).toHaveAttribute("maxlength", "6");
    expect(
      readyCodeInput.parentElement?.querySelectorAll(
        '[aria-hidden="true"] > span',
      ),
    ).toHaveLength(6);
    fireEvent.change(readyCodeInput, { target: { value: "123456" } });
    const form = containingForm(readyCodeInput);
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        mockedClerk.signUpAttemptEmailAddressVerification,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      mockedClerk.signUpAttemptEmailAddressVerification,
    ).toHaveBeenCalledWith({ code: "123456" });

    await act(async () => {
      attempt.resolve(
        moveSignUpTo({
          createdSessionId: "session_sign_up",
          hasPassword: true,
          status: "complete",
        }),
      );
      await attempt.promise;
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    const activation = mockedClerk.setActive.mock.calls[0]?.[0];
    expect(activation).toStrictEqual({
      navigate: expect.any(Function),
      session: "session_sign_up",
    });
    const redirectUrl = new URL(location.href);
    expect(redirectUrl.pathname).toBe("/onboarding");
    expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
    expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
  });

  it("requires configured legal consent and rejects Clerk-invalid passwords", async () => {
    const user = userEvent.setup();
    mockSignUpConfiguration({
      privacyPolicyUrl: "https://vm0.ai/legal/privacy",
      termsUrl: "https://vm0.ai/legal/terms",
    });
    setupSignUpPage({
      missingFields: ["email_address", "password", "legal_accepted"],
      requiredFields: ["email_address", "password", "legal_accepted"],
      status: null,
    });
    const { emailInput, passwordInput } = await fillRequiredDetails();
    expect(roleElement("link", "Terms of Service")).toHaveAttribute(
      "href",
      "https://vm0.ai/legal/terms",
    );
    expect(roleElement("link", "Privacy Policy")).toHaveAttribute(
      "href",
      "https://vm0.ai/legal/privacy",
    );

    const form = containingForm(emailInput);
    fireEvent.submit(form);
    const legalError = await screen.findByRole("alert");
    expect(legalError).toHaveTextContent(
      "Please read and accept the terms to continue",
    );
    const styleElement = document.createElement("style");
    const tailwindCompiler = await compile("@tailwind utilities;");
    styleElement.textContent = tailwindCompiler.build([
      ...legalError.classList,
    ]);
    document.head.append(styleElement);
    context.signal.addEventListener(
      "abort",
      () => {
        styleElement.remove();
      },
      { once: true },
    );
    const legalErrorStyle = getComputedStyle(legalError);
    expect([
      legalErrorStyle.borderTopWidth,
      legalErrorStyle.borderRightWidth,
      legalErrorStyle.borderBottomWidth,
      legalErrorStyle.borderLeftWidth,
    ]).toStrictEqual(["1px", "1px", "1px", "1px"]);
    expect(document.activeElement).toBe(legalError);
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();

    const legalConsent = screen.getByRole("checkbox");
    await user.click(legalConsent);
    await waitFor(() => {
      expect(legalConsent).toBeChecked();
    });
    mockSignUpPasswordValidation({
      complexity: { min_length: true },
      strength: undefined,
    });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your password is not strong enough.",
      );
    });
    const passwordError = screen.getByRole("alert");
    expect(document.activeElement).toBe(passwordError);
    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(passwordInput).toHaveAttribute("aria-describedby", passwordError.id);

    fireEvent.change(passwordInput, {
      target: { value: "valid-password" },
    });
    expect(screen.getByRole("alert")).toBe(passwordError);
    expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();

    mockSignUpPasswordValidation({ complexity: {}, strength: undefined });
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledWith(
        expect.objectContaining({ legalAccepted: true }),
      );
    });
  });

  it("waits for Clerk's delayed password-strength result before creating", async () => {
    let finishValidation:
      | ((validation: PasswordValidation) => void)
      | undefined;
    mockedClerk.signUpValidatePassword.mockImplementation(
      (_password, callbacks) => {
        finishValidation = callbacks?.onValidation;
      },
    );
    setupSignUpPage({ status: null });
    const { emailInput } = await fillRequiredDetails();

    fireEvent.submit(containingForm(emailInput));

    await waitFor(() => {
      expect(mockedClerk.signUpValidatePassword).toHaveBeenCalledWith(
        "valid-password",
        expect.objectContaining({ onValidation: expect.any(Function) }),
      );
    });
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();

    act(() => {
      finishValidation?.({
        complexity: {},
        strength: {
          keys: ["min_zxcvbn_strength"],
          result: {
            calcTime: 0,
            feedback: { suggestions: [], warning: null },
            guesses: 0,
            guessesLog10: 0,
            password: "valid-password",
            score: 0,
          },
          state: "fail",
        },
      });
    });

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Your password is not strong enough.",
    );
    expect(mockedClerk.clientSignUpCreate).not.toHaveBeenCalled();
  });

  it("shows expired verification recovery and lets the user edit the email before preparing once", async () => {
    setupSignUpPage(
      readyEmailVerificationState({
        emailVerificationExpireAt: new Date(now() - 1000),
        emailVerificationStatus: "expired",
      }),
    );

    const editEmail = await waitForRoleElement("button", "Edit email address");
    const expiredAlert = screen.getByRole("alert");
    expect(expiredAlert).toBeVisible();
    expect(document.activeElement).toBe(expiredAlert);
    await expect(
      waitForRoleElement("button", "Didn't receive a code? Resend"),
    ).resolves.toBeEnabled();
    fireEvent.click(editEmail);

    const emailInput = await screen.findByLabelText("Email address");
    expect(emailInput).toHaveValue("person@example.com");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.change(emailInput, {
      target: { value: "updated@example.com" },
    });
    mockedClerk.signUpUpdate.mockImplementation(() => {
      return moveSignUpToAsync(
        readyEmailVerificationState({
          emailAddress: "updated@example.com",
          emailVerificationExpireAt: null,
          emailVerificationStatus: null,
          emailVerificationStrategy: null,
        }),
      );
    });
    mockedClerk.signUpPrepareEmailAddressVerification.mockImplementation(() => {
      return moveSignUpToAsync(
        readyEmailVerificationState({ emailAddress: "updated@example.com" }),
      );
    });
    fireEvent.submit(containingForm(emailInput));

    await waitFor(() => {
      expect(mockedClerk.signUpUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ emailAddress: "updated@example.com" }),
      );
      expect(
        mockedClerk.signUpPrepareEmailAddressVerification,
      ).toHaveBeenCalledTimes(1);
    });
    await expect(
      screen.findByText("updated@example.com"),
    ).resolves.toBeVisible();
  });

  it("surfaces Turnstile loading, blocked, expired, and retry states", async () => {
    const create = createDeferredPromise<
      ReturnType<typeof currentSignUpResource>
    >(context.signal);
    mockSignUpConfiguration({ captchaEnabled: true });
    mockedClerk.clientSignUpCreate.mockImplementation(() => {
      return create.promise;
    });
    setupSignUpPage({ status: null });
    const { emailInput } = await fillRequiredDetails();
    const captcha = document.querySelector("#clerk-captcha");
    expect(captcha).toBeInstanceOf(HTMLDivElement);
    fireEvent.submit(containingForm(emailInput));

    await expect(screen.findByText("Loading…")).resolves.toBeVisible();
    if (!(captcha instanceof HTMLDivElement)) {
      throw new Error("Expected the Clerk CAPTCHA host");
    }
    captcha.dataset.clInteractive = "true";
    await waitFor(() => {
      expect(screen.getByText("Verifying your request")).toBeVisible();
    });

    await act(async () => {
      create.reject({
        errors: [
          {
            code: "captcha_invalid",
            longMessage: "Bot validation expired.",
            meta: { paramName: "captcha" },
          },
        ],
      });
      await expect(create.promise).rejects.toBeDefined();
    });

    const captchaError = await screen.findByRole("alert");
    expect(captchaError).toHaveTextContent(
      "Bot verification expired. Try again.",
    );
    expect(document.activeElement).toBe(captchaError);
    expect(screen.queryByText("Bot validation expired.")).toBeNull();
    mockedClerk.clientSignUpCreate.mockImplementation(() => {
      return moveSignUpToAsync({
        createdSessionId: "session_captcha",
        hasPassword: true,
        status: "complete",
      });
    });
    fireEvent.click(await waitForRoleElement("button", "Try again"));

    await waitFor(() => {
      expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledTimes(2);
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    {
      name: "transfer",
      state: readyEmailVerificationState({
        emailVerificationExpireAt: null,
        emailVerificationStatus: null,
        emailVerificationStrategy: null,
        isTransferable: true,
      }),
    },
    {
      name: "fail-closed recovery",
      state: {
        missingFields: ["phone_number"],
        requiredFields: ["phone_number"],
        status: "missing_requirements",
      },
    },
  ] as const)(
    "shows one owned restart indicator from the $name state",
    async ({ state }) => {
      const restart = createDeferredPromise<{ readonly error: null }>(
        context.signal,
      );
      mockedClerk.signUpFutureReset.mockImplementation(() => {
        return restart.promise;
      });
      setupSignUpPage(state);

      const restartButton = await waitForRoleElement(
        "button",
        "Use another method",
      );
      fireEvent.click(restartButton);

      await waitFor(() => {
        expect(mockedClerk.signUpFutureReset).toHaveBeenCalledTimes(1);
        expect(restartButton).toHaveAttribute("aria-busy", "true");
      });
      expect(restartButton).toHaveAccessibleName("Use another method");
      expect(restartButton).toBeDisabled();
      expect(restartButton.textContent?.trim()).toBe("");
      expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);

      moveSignUpTo({ status: null });
      await act(async () => {
        restart.resolve({ error: null });
        await restart.promise;
      });

      await expect(
        screen.findByLabelText("Email address"),
      ).resolves.toBeVisible();
    },
  );

  it.each([
    {
      name: "a transferable identity",
      state: readyEmailVerificationState({
        emailVerificationExpireAt: null,
        emailVerificationStatus: null,
        emailVerificationStrategy: null,
        isTransferable: true,
      }),
      title: "Sign in",
    },
    {
      name: "an unsupported required field",
      state: {
        missingFields: ["phone_number"],
        requiredFields: ["phone_number"],
        status: "missing_requirements",
      },
      title: "Access restricted",
    },
    {
      name: "a completed attempt without a session",
      state: { status: "complete" },
      title: "Access restricted",
    },
  ])(
    "renders explicit transfer or recovery UI for $name",
    async ({ state, title }) => {
      const redirectUrl = "https://app.okou.ai/onboarding?source=sign-up";
      setupSignUpPage(state, {
        path: `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`,
      });

      await expect(
        screen.findByRole(title === "Sign in" ? "link" : "heading", {
          name: title,
        }),
      ).resolves.toBeVisible();
      const signIn = roleElement("link", "Sign in");
      expect(signIn).toHaveAttribute(
        "href",
        expect.stringContaining("redirect_url="),
      );
      expect(
        mockedClerk.signUpPrepareEmailAddressVerification,
      ).not.toHaveBeenCalled();
    },
  );
});
