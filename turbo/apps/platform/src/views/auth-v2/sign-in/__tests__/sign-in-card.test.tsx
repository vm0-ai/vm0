import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../../__tests__/page-helper.ts";
import {
  mockAuthV2Capabilities,
  mockedGoogleOneTap,
  mockedClerk,
  mockGoogleOneTapCredential,
  mockSignInResource,
  type MockedClientSession,
  type MockedSignInFactor,
  type MockedSignInResourceState,
} from "../../../../__tests__/mock-auth.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { AUTH_V2_SIGN_IN_RESEND_COOLDOWN_STORAGE_KEY } from "../../../../signals/auth-v2/resend-cooldown.ts";
import { sessionStorageSignals } from "../../../../signals/external/session-storage.ts";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../../../signals/route.ts";
import { pushState } from "../../../../signals/location.ts";
import { createDeferredPromise } from "../../../../signals/utils.ts";
import { mockNow } from "../../../../lib/time.ts";
import { renderedIdentityEditPresentation } from "../../__tests__/auth-v2-button-style-assertions.ts";
import {
  renderedCheckboxPresentation,
  renderedFocusedElementPresentation,
} from "../../__tests__/auth-v2-style-assertions.ts";

const context = testContext();
const signInResendCooldownStorage = sessionStorageSignals(
  AUTH_V2_SIGN_IN_RESEND_COOLDOWN_STORAGE_KEY,
);

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

function googleOAuthFactor(): MockedSignInFactor {
  return { strategy: "oauth_google" };
}

function passkeyFactor(): MockedSignInFactor {
  return { strategy: "passkey" };
}

function currentSignInResource() {
  return mockedClerk.client.signIn;
}

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return currentSignInResource();
}

function currentSignInResourceAsync(): Promise<
  ReturnType<typeof currentSignInResource>
> {
  return Promise.resolve(currentSignInResource());
}

function moveSignInToAsync(
  state: MockedSignInResourceState,
): Promise<ReturnType<typeof currentSignInResource>> {
  return Promise.resolve(moveSignInTo(state));
}

function mockPreparedFirstFactor(
  strategy: "email_code" | "reset_password_email_code",
): void {
  const signInResource = currentSignInResource();
  Object.defineProperty(signInResource, "firstFactorVerification", {
    configurable: true,
    value: { status: "unverified", strategy },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      Reflect.deleteProperty(signInResource, "firstFactorVerification");
    },
    { once: true },
  );
}

interface SetupSignInPageOptions {
  readonly url?: string;
  readonly user?: {
    readonly clientSessions: MockedClientSession[];
    readonly email?: string;
    readonly fullName: string;
    readonly id: string;
  } | null;
}

function setupSignInPage(
  state: MockedSignInResourceState,
  options: SetupSignInPageOptions = {},
): Promise<void> {
  mockSignInResource(state);
  const url = new URL(options.url ?? "https://app.vm0.ai/sign-in");
  return setupPage({
    context,
    host: url.hostname,
    path: `${url.pathname}${url.search}${url.hash}`,
    auth: options.user
      ? {
          session: null,
          user: options.user,
        }
      : null,
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

function navigateToSignUp(): void {
  // These cases exercise teardown after address-bar navigation. JSDOM cannot
  // perform a document navigation, so invoke the production router command.
  context.store.set(detachedNavigateTo$, ROUTES.signUp);
}

function expectFieldErrorAssociation(
  input: HTMLElement,
  alert: HTMLElement,
): void {
  const description = alert.textContent;
  if (!description) {
    throw new Error("Expected the field error alert to have text");
  }
  expect(alert.id).not.toBe("");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", alert.id);
  expect(input).toHaveAccessibleDescription(description);
}

function expectNoFieldErrorAssociation(input: HTMLElement): void {
  expect(input).not.toHaveAttribute("aria-invalid");
  expect(input).not.toHaveAttribute("aria-describedby");
}

function signUpSwitchContext(): {
  readonly expectedHref: string;
  readonly url: string;
} {
  const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
  const searchParams = new URLSearchParams([
    ["redirect_url", redirectUrl],
    ["gclid", "click-123"],
    ["utm_campaign", "summer"],
    ["utm_content", "hero"],
    ["utm_content", "footer"],
  ]);
  const hash = `#/factor-one?step=code&redirect_url=${encodeURIComponent(redirectUrl)}`;
  return {
    expectedHref: `/sign-up?${searchParams.toString()}${hash}`,
    url: `https://app.vm0.ai/sign-in?${searchParams.toString()}${hash}`,
  };
}

function createStalledGoogleOneTapScript(): HTMLScriptElement {
  const script = document.createElement("script");
  script.dataset.authV2GoogleOneTap = "true";
  document.head.appendChild(script);
  return script;
}

function mockIdentifierSubmission(
  factors: readonly MockedSignInFactor[],
): void {
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    return moveSignInToAsync({
      status: "needs_first_factor",
      supportedFirstFactors: factors,
    });
  });
}

async function submitIdentifier(identifier: string): Promise<void> {
  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, identifier);
  fireEvent.submit(containingForm(identifierInput));

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({ identifier });
  });
}

function mockExpiredVerificationAttempt(): void {
  mockedClerk.signInPrepareFirstFactor.mockResolvedValue(
    currentSignInResource(),
  );
  mockedClerk.signInAttemptFirstFactor.mockRejectedValue({
    errors: [
      {
        code: "verification_expired",
        longMessage: "Sensitive provider detail must not be rendered.",
      },
    ],
  });
}

async function openVerificationCodeStep(
  method: string,
  title: string,
): Promise<HTMLElement> {
  click(await waitForRoleElement("button", method));

  const codeInput = await screen.findByLabelText("Verification code");
  expect(screen.getByRole("heading", { level: 1, name: title })).toBeVisible();
  expect(screen.getAllByRole("heading")).toHaveLength(1);
  expect(roleElement("button", "Back")).toBeUndefined();
  return codeInput;
}

async function recoverExpiredCodeWithOneResend(
  codeInput: HTMLElement,
): Promise<void> {
  fireEvent.change(codeInput, { target: { value: "123456" } });
  fireEvent.submit(containingForm(codeInput));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "This verification code has expired. Request a new code.",
  );
  expect(document.activeElement).toBe(alert);
  expectFieldErrorAssociation(codeInput, alert);
  expect(
    screen.queryByText("Sensitive provider detail must not be rendered."),
  ).toBeNull();

  fireEvent.change(codeInput, { target: { value: "654321" } });
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(codeInput).toHaveValue("654321");
  expectNoFieldErrorAssociation(codeInput);

  fireEvent.submit(containingForm(codeInput));
  const retryAlert = await screen.findByRole("alert");
  expect(document.activeElement).toBe(retryAlert);
  expectFieldErrorAssociation(codeInput, retryAlert);

  const resend = await waitForRoleElement(
    "button",
    "Didn't receive a code? Resend",
  );
  expect(resend).toBeEnabled();
  click(resend);
  click(resend);

  await waitFor(() => {
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expectNoFieldErrorAssociation(codeInput);
  });
  expect(codeInput).toHaveValue("");
}

interface RestoredPreparedStepOptions {
  readonly cooldownIdentity: string;
  readonly factor: MockedSignInFactor;
  readonly strategy: "email_code" | "reset_password_email_code";
}

async function setupRestoredPreparedStep(
  options: RestoredPreparedStepOptions,
): Promise<void> {
  const startedAt = Date.parse("2026-08-25T08:00:00.000Z");
  mockNow(startedAt + 1000, context.signal);
  context.store.set(
    signInResendCooldownStorage.set$,
    JSON.stringify({
      deadlineMs: startedAt + 30_000,
      identity: options.cooldownIdentity,
    }),
  );
  mockPreparedFirstFactor(options.strategy);
  await setupSignInPage({
    identifier: "person@example.com",
    status: "needs_first_factor",
    supportedFirstFactors: [options.factor, passwordFactor()],
  });

  await expect(
    screen.findByLabelText("Verification code"),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Didn't receive a code? Resend (29)"),
  ).resolves.toBeDisabled();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

  click(screen.getByLabelText("Toggle theme"));
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
}

async function editRestoredIdentifier(): Promise<void> {
  click(await waitForRoleElement("button", "Edit identifier"));
  await expect(screen.findByLabelText("Email address")).resolves.toHaveValue(
    "person@example.com",
  );
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
}

test("A fresh sign-in does not reuse an earlier email draft", async () => {
  await setupSignInPage({
    identifier: "previous@example.com",
    status: "needs_identifier",
  });

  await expect(screen.findByLabelText("Email address")).resolves.toHaveValue(
    "",
  );
  expect(screen.getByLabelText("Email address")).toHaveAttribute(
    "placeholder",
    "Enter your email address",
  );
  expect(screen.getByLabelText("Email address")).toHaveAttribute(
    "autocomplete",
    "email",
  );
});

test("Switching from sign-in to sign-up preserves navigation context", async () => {
  const { expectedHref, url } = signUpSwitchContext();
  await setupSignInPage({ status: "needs_identifier" }, { url });

  const signUp = await waitForRoleElement("link", "Sign up");
  expect(signUp).toHaveAttribute("href", expectedHref);
  expect(screen.getByRole("region", { name: /^Sign in to / })).toContainElement(
    signUp,
  );
  expect(signUp.parentElement).toHaveTextContent(
    "Don’t have an account? Sign up",
  );
});

test("A visitor signs in with a password", async () => {
  const user = userEvent.setup({ delay: null });
  const attempt = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
    return attempt.promise;
  });
  mockIdentifierSubmission([passwordFactor()]);

  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  const passwordInput = await screen.findByLabelText("Password");
  expect(document.activeElement).toBe(
    screen.getByRole("heading", { level: 1, name: "Enter your password" }),
  );
  expect(screen.getAllByRole("heading")).toHaveLength(1);
  expect(passwordInput).toHaveAttribute("placeholder", "Enter your password");
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
  const revealPassword = await waitForRoleElement("button", "Show password");
  expect(revealPassword).toHaveAttribute("aria-pressed", "false");
  expect(passwordInput).toHaveAttribute("type", "password");
  revealPassword.focus();
  await user.keyboard("{Enter}");
  expect(passwordInput).toHaveAttribute("type", "text");
  await expect(
    waitForRoleElement("button", "Hide password"),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  await user.keyboard(" ");
  expect(passwordInput).toHaveAttribute("type", "password");
  expect(mockedClerk.signInAttemptFirstFactor).not.toHaveBeenCalled();
  await fill(passwordInput, "correct-password");
  const passwordForm = containingForm(passwordInput);
  const continueButton = await waitForRoleElement("button", "Continue");
  fireEvent.submit(passwordForm);
  fireEvent.submit(passwordForm);

  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledWith({
    password: "correct-password",
    strategy: "password",
  });
  await waitFor(() => {
    expect(continueButton).toHaveAttribute("aria-busy", "true");
  });
  expect(continueButton).toHaveAccessibleName("Continue");
  expect(continueButton.textContent?.trim()).toBe("");

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
    navigate: expect.any(Function),
    session: "session_password",
  });
});

test("A new device requires email verification after a correct password", async () => {
  const passwordAttempt = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  const clientTrustPreparation = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  const clientTrustAttempt = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  mockedClerk.signInAttemptFirstFactor.mockReturnValue(passwordAttempt.promise);
  mockedClerk.signInPrepareSecondFactor.mockReturnValue(
    clientTrustPreparation.promise,
  );
  mockedClerk.signInAttemptSecondFactor.mockReturnValue(
    clientTrustAttempt.promise,
  );
  mockIdentifierSubmission([passwordFactor()]);

  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  const passwordInput = await screen.findByLabelText("Password");
  await fill(passwordInput, "correct-password");
  fireEvent.submit(containingForm(passwordInput));

  await act(async () => {
    passwordAttempt.resolve(
      moveSignInTo({
        identifier: "person@example.com",
        status: "needs_client_trust",
        supportedSecondFactors: [emailCodeFactor()],
      }),
    );
    await passwordAttempt.promise;
  });

  await waitFor(() => {
    expect(mockedClerk.signInPrepareSecondFactor).toHaveBeenCalledWith({
      emailAddressId: "email_primary",
      strategy: "email_code",
    });
  });
  await act(async () => {
    clientTrustPreparation.resolve(
      moveSignInTo({
        identifier: "person@example.com",
        secondFactorVerificationStatus: "unverified",
        secondFactorVerificationStrategy: "email_code",
        status: "needs_client_trust",
        supportedSecondFactors: [emailCodeFactor()],
      }),
    );
    await clientTrustPreparation.promise;
  });
  const codeInput = await screen.findByLabelText("Verification code");
  expect(
    screen.getByRole("heading", { level: 1, name: "Check your email" }),
  ).toBeVisible();
  expect(screen.getByText("p***@example.com")).toBeVisible();
  expect(
    screen.getByText(
      "You're signing in from a new device. We're asking for verification to keep your account secure.",
    ),
  ).toBeVisible();
  await expect(waitForRoleElement("button", "Back")).resolves.toBeVisible();
  expect(roleElement("button", "Use another method")).toBeUndefined();
  expect(roleElement("link", "Sign up")).toBeUndefined();
  await fill(codeInput, "424242");
  fireEvent.submit(containingForm(codeInput));

  await act(async () => {
    clientTrustAttempt.resolve(
      moveSignInTo({
        createdSessionId: "session_device_trust",
        status: "complete",
      }),
    );
    await clientTrustAttempt.promise;
  });

  await waitFor(() => {
    expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenCalledWith({
      code: "424242",
      strategy: "email_code",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.setActive).toHaveBeenCalledWith({
    navigate: expect.any(Function),
    session: "session_device_trust",
  });
});

test("Sign-in fails safely when device trust cannot be completed", async () => {
  await setupSignInPage({
    status: "needs_client_trust",
    supportedSecondFactors: [{ strategy: "totp" }],
  });

  await expect(
    screen.findByRole("heading", { name: "Cannot sign in" }),
  ).resolves.toBeVisible();
  expect(mockedClerk.signInPrepareSecondFactor).not.toHaveBeenCalled();
});

test("A visitor can inspect other sign-in methods and return to their password", async () => {
  mockAuthV2Capabilities({ appleOAuth: true, googleOAuth: true });
  mockIdentifierSubmission([
    passwordFactor(),
    emailCodeFactor(),
    passwordResetFactor(),
  ]);
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
  expect(roleElement("link", "Sign up")).toBeUndefined();
  const editIdentifier = await waitForRoleElement("button", "Edit identifier");
  await expect(
    renderedIdentityEditPresentation(editIdentifier, context.signal),
  ).resolves.toStrictEqual({
    borderRadius: "8px",
    color: "rgb(100 110 120)",
    height: "calc(4px * 6)",
    iconHeight: "calc(4px * 4)",
    iconWidth: "calc(4px * 4)",
    rowMinHeight: "calc(4px * 6)",
    width: "calc(4px * 6)",
  });

  click(await waitForRoleElement("button", "Use another method"));

  await expect(
    screen.findByRole("heading", { name: "Use another method" }),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Continue with Apple"),
  ).resolves.toHaveTextContent("Apple");
  await expect(
    waitForRoleElement("button", "Continue with Google"),
  ).resolves.toHaveTextContent("Google");
  await expect(
    waitForRoleElement("button", "Email code to p***@example.com"),
  ).resolves.toBeVisible();
  expect(roleElement("button", "Sign in with your password")).toBeUndefined();
  expect(roleElement("button", "Reset your password")).toBeUndefined();
  const getHelp = await waitForRoleElement("button", "Get help");
  expect(getHelp).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Use another method" }),
  ).toContainElement(getHelp);
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

  click(await waitForRoleElement("button", "Back"));

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Enter your password" }),
  ).toBeVisible();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
});

test("Preparing a sign-in method keeps progress on the selected choice", async () => {
  const preparation = createDeferredPromise<
    ReturnType<typeof currentSignInResource>
  >(context.signal);
  mockedClerk.signInPrepareFirstFactor.mockImplementation(async () => {
    const resource = await preparation.promise;
    mockPreparedFirstFactor("email_code");
    return resource;
  });
  mockAuthV2Capabilities({
    appleOAuth: true,
    googleOAuth: true,
    passkey: true,
  });
  context.mocks.browser.webAuthn({ platformAuthenticatorResult: true });
  mockIdentifierSubmission([
    passwordFactor(),
    emailCodeFactor(),
    passwordResetFactor(),
    passkeyFactor(),
  ]);
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  click(await waitForRoleElement("button", "Forgot password?"));
  const reset = await waitForRoleElement("button", "Reset your password");
  const apple = await waitForRoleElement("button", "Continue with Apple");
  const google = await waitForRoleElement("button", "Continue with Google");
  const email = await waitForRoleElement(
    "button",
    "Email code to p***@example.com",
  );
  const passkey = await waitForRoleElement(
    "button",
    "Sign in with your passkey",
  );

  click(email);

  await waitFor(() => {
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);
    expect(email).toHaveAttribute("aria-busy", "true");
  });
  expect(email).toHaveAccessibleName("Email code to p***@example.com");
  expect(email.textContent?.trim()).toBe("");
  for (const competingAction of [reset, apple, google, passkey]) {
    expect(competingAction).toBeDisabled();
    expect(competingAction).toHaveAttribute("aria-busy", "false");
    expect(competingAction.textContent?.trim()).not.toBe("");
  }
  expect(
    queryAllByRoleFast("button").filter((button) => {
      return button.getAttribute("aria-busy") === "true";
    }),
  ).toStrictEqual([email]);

  await act(async () => {
    preparation.resolve(currentSignInResource());
    await preparation.promise;
  });

  await expect(
    screen.findByLabelText("Verification code"),
  ).resolves.toBeVisible();
});

test("Password errors are safe, relevant, and cleared by a meaningful edit", async () => {
  mockIdentifierSubmission([passwordFactor()]);
  mockedClerk.signInAttemptFirstFactor
    .mockRejectedValueOnce({
      errors: [
        {
          code: "form_identifier_invalid",
          longMessage: "Private identifier provider detail.",
          meta: { paramName: "identifier" },
        },
      ],
    })
    .mockRejectedValueOnce({
      errors: [
        {
          code: "form_password_incorrect",
          longMessage: "Private password provider detail.",
          meta: { paramName: "password" },
        },
      ],
    });
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  const passwordInput = await screen.findByLabelText("Password");

  await fill(passwordInput, "first-attempt");
  fireEvent.submit(containingForm(passwordInput));

  const unrelatedAlert = await screen.findByRole("alert");
  expect(document.activeElement).toBe(unrelatedAlert);
  expectNoFieldErrorAssociation(passwordInput);
  expect(screen.queryByText("Private identifier provider detail.")).toBeNull();

  await fill(passwordInput, "second-attempt");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(passwordInput).toHaveValue("second-attempt");
  expectNoFieldErrorAssociation(passwordInput);

  fireEvent.submit(containingForm(passwordInput));
  const passwordAlert = await screen.findByRole("alert");
  expect(document.activeElement).toBe(passwordAlert);
  expectFieldErrorAssociation(passwordInput, passwordAlert);
  expect(screen.queryByText("Private password provider detail.")).toBeNull();

  await fill(passwordInput, "second-attempt");
  expect(screen.getByRole("alert")).toBe(passwordAlert);
  expectFieldErrorAssociation(passwordInput, passwordAlert);

  await fill(passwordInput, "retry-password");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(passwordInput).toHaveValue("retry-password");
  expectNoFieldErrorAssociation(passwordInput);
});

test("Sign-in presents configured social providers and remembers the last one used", async () => {
  const redirect = createDeferredPromise<void>(context.signal);
  mockedClerk.signInAuthenticateWithRedirect.mockImplementation(() => {
    return redirect.promise;
  });
  mockAuthV2Capabilities({
    appleOAuth: true,
    googleOAuth: true,
    lastAuthenticationStrategy: "oauth_google",
  });
  await setupSignInPage({ status: "needs_identifier" });

  const apple = await waitForRoleElement("button", "Continue with Apple");
  const google = await waitForRoleElement("button", "Continue with Google");
  expect(apple.textContent?.trim()).toBe("Apple");
  expect(google).toHaveTextContent("Google");
  expect(within(google).getByText("Last used")).toBeVisible();
  expect(within(apple).queryByText("Last used")).not.toBeInTheDocument();

  click(apple);
  await waitFor(() => {
    expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "oauth_apple" }),
    );
    expect(apple).toHaveAttribute("aria-busy", "true");
  });
  expect(apple).toHaveAccessibleName("Continue with Apple");
  expect(apple.textContent?.trim()).toBe("");
  expect(google).toBeDisabled();
  expect(google).toHaveAttribute("aria-busy", "false");
  expect(google).toHaveTextContent("Google");
  expect(within(google).getByText("Last used")).toBeVisible();

  await act(async () => {
    redirect.resolve(undefined);
    await redirect.promise;
  });
  await waitFor(() => {
    expect(apple).toHaveAttribute("aria-busy", "false");
    expect(apple).toHaveTextContent("Apple");
  });
});

test("Google OAuth preserves trusted navigation context and completes once", async () => {
  const redirectUrl = "https://app.okou.ai/onboarding?source=oauth";
  const authSearch = new URLSearchParams({
    redirect_url: redirectUrl,
    utm_campaign: "oauth",
  });
  const authHash = "#/?step=start";
  mockAuthV2Capabilities({ googleOAuth: true });
  mockedClerk.setActive.mockImplementation((params) => {
    if (params.redirectUrl) {
      window.location.href = params.redirectUrl;
    }
    return Promise.resolve();
  });
  mockedClerk.handleRedirectCallback.mockImplementation(async (params) => {
    moveSignInTo({
      createdSessionId: "session_oauth",
      status: "complete",
    });
    await mockedClerk.setActive({
      redirectUrl: params?.signInForceRedirectUrl ?? undefined,
      session: "session_oauth",
    });
  });
  await setupSignInPage(
    { status: "needs_identifier" },
    {
      url: `https://app.vm0.ai/sign-in?${authSearch.toString()}${authHash}`,
    },
  );

  const google = await waitForRoleElement("button", "Continue with Google");
  click(google);
  click(google);

  await waitFor(() => {
    expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledWith({
    redirectUrl: `/sign-in/sso-callback?${authSearch.toString()}${authHash}`,
    redirectUrlComplete: redirectUrl,
    strategy: "oauth_google",
  });

  await act(async () => {
    pushState(
      {},
      "",
      `/sign-in/sso-callback?redirect_url=${encodeURIComponent(redirectUrl)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(mockedClerk.handleRedirectCallback).toHaveBeenCalledTimes(1);
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.handleRedirectCallback).toHaveBeenCalledWith(
    expect.objectContaining({
      firstFactorUrl: expect.stringContaining("/sign-in/factor-one"),
      reloadResource: "signIn",
      signInFallbackRedirectUrl: redirectUrl,
      signInForceRedirectUrl: redirectUrl,
      transferable: false,
    }),
  );
  expect(mockedClerk.setActive).toHaveBeenCalledWith({
    redirectUrl,
    session: "session_oauth",
  });
  await waitFor(() => {
    expect(location.href).toBe(redirectUrl);
  });
});

test("Google One Tap signs in from the base sign-in page", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential("google-one-tap-token");
  mockedClerk.clientSignInCreate.mockImplementation((params) => {
    if (params.strategy === "google_one_tap") {
      return moveSignInToAsync({
        createdSessionId: "session_one_tap",
        status: "complete",
      });
    }
    return currentSignInResourceAsync();
  });

  await setupSignInPage({ status: "needs_identifier" });

  await waitFor(() => {
    expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      signUpIfMissing: false,
      strategy: "google_one_tap",
      token: "google-one-tap-token",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
  expect(mockedGoogleOneTap.initialize).toHaveBeenCalledTimes(1);
  expect(mockedGoogleOneTap.initialize).toHaveBeenCalledWith({
    auto_select: false,
    callback: expect.any(Function),
    cancel_on_tap_outside: true,
    client_id: "google-client-id",
    itp_support: true,
    use_fedcm_for_prompt: true,
  });
});

test("Dismissing Google One Tap leaves ordinary sign-in undisturbed", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential(null);
  mockedGoogleOneTap.prompt.mockImplementation((callback) => {
    callback({
      getMomentType: () => {
        return "display";
      },
    });
    callback({
      getMomentType: () => {
        return "skipped";
      },
    });
  });

  await setupSignInPage({ status: "needs_identifier" });

  await waitFor(() => {
    expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("A stalled Google One Tap prompt does not block ordinary sign-in", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential(null);
  mockedGoogleOneTap.prompt.mockImplementation(() => {});

  await setupSignInPage({ status: "needs_identifier" });

  await expect(
    screen.findByRole("region", { name: "Sign in to VM0" }),
  ).resolves.toBeVisible();
  await expect(screen.findByLabelText("Email address")).resolves.toBeEnabled();
  await expect(
    waitForRoleElement("button", "Continue with Google"),
  ).resolves.toBeEnabled();
  expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
});

test("Google One Tap is limited to the active base sign-in page", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential(null);
  mockedGoogleOneTap.prompt.mockImplementation(() => {});

  await setupSignInPage(
    { status: "needs_identifier" },
    { url: "https://app.vm0.ai/sign-in/factor-one" },
  );

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(mockedGoogleOneTap.initialize).not.toHaveBeenCalled();
  expect(mockedGoogleOneTap.prompt).not.toHaveBeenCalled();

  await act(async () => {
    pushState({}, "", "/sign-in");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await Promise.resolve();
  });

  await waitFor(() => {
    expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
  });
  const initializeOptions =
    mockedGoogleOneTap.initialize.mock.calls.at(-1)?.[0];
  const promptCallback = mockedGoogleOneTap.prompt.mock.calls.at(-1)?.[0];
  if (!initializeOptions || !promptCallback) {
    throw new Error("Expected Google One Tap callbacks to be registered");
  }

  navigateToSignUp();
  await expect(
    screen.findByRole("region", { name: "Create your account" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(mockedGoogleOneTap.cancel).toHaveBeenCalledTimes(1);
  });

  initializeOptions.callback({ credential: "late-google-one-tap-token" });
  promptCallback({
    getMomentType: () => {
      return "skipped";
    },
  });

  expect(mockedGoogleOneTap.cancel).toHaveBeenCalledTimes(1);
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
});

test("Google One Tap fails silently and can recover after navigation", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockedClerk.clientSignInCreate.mockImplementation((params) => {
    if (params.strategy === "google_one_tap") {
      return moveSignInToAsync({
        createdSessionId: "session_one_tap_retry",
        status: "complete",
      });
    }
    return currentSignInResourceAsync();
  });
  const failedScript = createStalledGoogleOneTapScript();
  const failedScriptListeners = vi.spyOn(failedScript, "addEventListener");
  const pageReady = setupSignInPage({ status: "needs_identifier" });

  // Script loading is a browser resource boundary and cannot be triggered
  // through a rendered control, so dispatch its terminal event directly.
  await screen.findByLabelText("Email address");
  await waitFor(() => {
    expect(failedScriptListeners).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
      { once: true },
    );
  });
  await act(async () => {
    fireEvent.error(failedScript);
    await Promise.resolve();
  });
  await pageReady;

  await waitFor(() => {
    expect(failedScript).not.toBeInTheDocument();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await expect(screen.findByLabelText("Email address")).resolves.toBeEnabled();
  await expect(
    waitForRoleElement("button", "Continue with Google"),
  ).resolves.toBeEnabled();

  navigateToSignUp();
  await expect(
    screen.findByRole("region", { name: "Create your account" }),
  ).resolves.toBeVisible();

  const retryScript = createStalledGoogleOneTapScript();
  const retryScriptListeners = vi.spyOn(retryScript, "addEventListener");
  act(() => {
    window.history.back();
  });
  expect(retryScript).not.toBe(failedScript);
  await waitFor(() => {
    expect(retryScriptListeners).toHaveBeenCalledWith(
      "load",
      expect.any(Function),
      { once: true },
    );
  });
  await expect(
    screen.findByRole("region", { name: "Sign in to VM0" }),
  ).resolves.toBeVisible();
  await expect(screen.findByLabelText("Email address")).resolves.toBeEnabled();

  mockGoogleOneTapCredential("retry-google-one-tap-token");
  fireEvent.load(retryScript);

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      signUpIfMissing: false,
      strategy: "google_one_tap",
      token: "retry-google-one-tap-token",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
});

test("Google One Tap falls back silently when the browser cannot support it", async () => {
  context.mocks.browser.fedCm();
  mockAuthV2Capabilities({
    googleOAuth: true,
    googleOneTapClientId: "google-client-id",
  });
  mockGoogleOneTapCredential(null);
  mockedGoogleOneTap.prompt.mockImplementation(() => {
    throw new Error("Error connecting to Web Authentication service.");
  });

  await setupSignInPage({ status: "needs_identifier" });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  await waitFor(() => {
    expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
  });
  expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Unsupported devices hide passkey while preserving other sign-in methods", async () => {
  context.mocks.browser.webAuthn({ secureContext: false });
  mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
  await setupSignInPage({
    status: "needs_first_factor",
    supportedFirstFactors: [
      passwordFactor(),
      emailCodeFactor(),
      googleOAuthFactor(),
      passkeyFactor(),
    ],
  });

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Passkeys are not supported on this device.",
  );
  expect(roleElement("button", "Sign in with your passkey")).toBeUndefined();
  for (const method of [
    "Continue with Google",
    "Email code to p***@example.com",
    "Sign in with your password",
  ]) {
    await expect(waitForRoleElement("button", method)).resolves.toBeEnabled();
  }

  click(await waitForRoleElement("button", "Sign in with your password"));

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
});

test("An uncertain optional passkey check does not block passkey sign-in", async () => {
  context.mocks.browser.webAuthn({
    platformAuthenticatorResult: "error",
  });
  mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
  await setupSignInPage({ status: "needs_identifier" });

  await expect(
    waitForRoleElement("button", "Sign in with your passkey"),
  ).resolves.toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Cancelling passkey verification leaves every sign-in method usable", async () => {
  const privateMessage = "The passkey request was cancelled.";
  context.mocks.browser.webAuthn({ platformAuthenticatorResult: true });
  mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
  mockedClerk.signInAuthenticateWithPasskey.mockRejectedValue({
    code: "passkey_retrieval_cancelled",
    message: privateMessage,
  });
  await setupSignInPage({
    status: "needs_first_factor",
    supportedFirstFactors: [
      passwordFactor(),
      emailCodeFactor(),
      googleOAuthFactor(),
      passkeyFactor(),
    ],
  });

  const passkey = await waitForRoleElement(
    "button",
    "Sign in with your passkey",
  );
  click(passkey);

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Passkey verification was cancelled or timed out.",
  );
  expect(screen.queryByText(privateMessage)).not.toBeInTheDocument();
  for (const method of [
    passkey,
    await waitForRoleElement("button", "Continue with Google"),
    await waitForRoleElement("button", "Email code to p***@example.com"),
    await waitForRoleElement("button", "Sign in with your password"),
  ]) {
    expect(method).toBeEnabled();
  }
});

test("A runtime passkey incompatibility removes only the passkey choice", async () => {
  context.mocks.browser.webAuthn({ platformAuthenticatorResult: true });
  mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
  mockedClerk.signInAuthenticateWithPasskey.mockRejectedValue({
    code: "passkey_not_supported",
    message: "Private device capability detail.",
  });
  await setupSignInPage({
    status: "needs_first_factor",
    supportedFirstFactors: [
      passwordFactor(),
      emailCodeFactor(),
      googleOAuthFactor(),
      passkeyFactor(),
    ],
  });

  const passkey = await waitForRoleElement(
    "button",
    "Sign in with your passkey",
  );
  click(passkey);

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Passkeys are not supported on this device.",
  );
  expect(
    screen.queryByText("Private device capability detail."),
  ).not.toBeInTheDocument();
  await waitFor(() => {
    expect(roleElement("button", "Sign in with your passkey")).toBeUndefined();
  });
  for (const method of [
    "Continue with Google",
    "Email code to p***@example.com",
    "Sign in with your password",
  ]) {
    await expect(waitForRoleElement("button", method)).resolves.toBeEnabled();
  }
});

test("A passkey verification failure keeps recovery methods available", async () => {
  const privateMessage = "Your passkey could not be verified.";
  context.mocks.browser.webAuthn({ platformAuthenticatorResult: true });
  mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
  mockedClerk.signInAuthenticateWithPasskey.mockRejectedValue({
    code: "passkey_retrieval_failed",
    message: privateMessage,
  });
  await setupSignInPage({
    status: "needs_first_factor",
    supportedFirstFactors: [
      passwordFactor(),
      emailCodeFactor(),
      googleOAuthFactor(),
      passkeyFactor(),
    ],
  });

  const passkey = await waitForRoleElement(
    "button",
    "Sign in with your passkey",
  );
  click(passkey);
  click(passkey);

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(screen.queryByText(privateMessage)).not.toBeInTheDocument();
  expect(mockedClerk.signInAuthenticateWithPasskey).toHaveBeenCalledTimes(1);
  for (const method of [
    passkey,
    await waitForRoleElement("button", "Continue with Google"),
    await waitForRoleElement("button", "Email code to p***@example.com"),
    await waitForRoleElement("button", "Sign in with your password"),
  ]) {
    expect(method).toBeEnabled();
  }

  click(await waitForRoleElement("button", "Continue with Google"));

  await waitFor(() => {
    expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledTimes(1);
  });
});

test("A visitor signs in with an emailed verification code", async () => {
  mockAuthV2Capabilities({ appleOAuth: true, googleOAuth: true });
  const startedAt = Date.parse("2026-08-25T08:00:00.000Z");
  mockNow(startedAt, context.signal);
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
  mockIdentifierSubmission([passwordFactor(), emailCodeFactor()]);

  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");
  click(await waitForRoleElement("button", "Use another method"));

  const appleMethod = await waitForRoleElement("button", "Continue with Apple");
  const googleMethod = await waitForRoleElement(
    "button",
    "Continue with Google",
  );
  const emailMethod = await waitForRoleElement(
    "button",
    "Email code to p***@example.com",
  );
  click(emailMethod);
  click(emailMethod);

  await waitFor(() => {
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);
    expect(emailMethod).toHaveAttribute("aria-busy", "true");
  });
  expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenLastCalledWith({
    emailAddressId: "email_primary",
    strategy: "email_code",
  });
  await waitFor(() => {
    expect(emailMethod).toBeDisabled();
  });
  expect(emailMethod).toHaveAccessibleName("Email code to p***@example.com");
  expect(emailMethod.textContent?.trim()).toBe("");
  for (const competingMethod of [appleMethod, googleMethod]) {
    expect(competingMethod).toBeDisabled();
    expect(competingMethod).toHaveAttribute("aria-busy", "false");
    expect(competingMethod.textContent?.trim()).not.toBe("");
  }
  expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();

  await act(async () => {
    prepare.resolve(currentSignInResource());
    await prepare.promise;
  });

  const codeInput = await screen.findByLabelText("Verification code");
  codeInput.focus();
  await waitFor(() => {
    expect(document.activeElement).toBe(codeInput);
  });
  fireEvent.change(codeInput, { target: { value: "1" } });
  expect(codeInput).toHaveValue("1");
  fireEvent.change(codeInput, { target: { value: "12" } });
  expect(codeInput).toHaveValue("12");
  fireEvent.change(codeInput, { target: { value: "" } });
  expect(
    screen.getByRole("heading", { level: 1, name: "Check your email" }),
  ).toBeVisible();
  expect(screen.getAllByRole("heading")).toHaveLength(1);
  await expect(
    waitForRoleElement("button", "Use another method"),
  ).resolves.toBeVisible();
  expect(roleElement("link", "Sign up")).toBeUndefined();
  click(await waitForRoleElement("button", "Use another method"));
  await expect(
    screen.findByRole("heading", { name: "Use another method" }),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Sign in with your password"),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Continue with Apple"),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Continue with Google"),
  ).resolves.toBeVisible();
  expect(
    roleElement("button", "Email code to p***@example.com"),
  ).toBeUndefined();
  expect(roleElement("button", "Reset your password")).toBeUndefined();
  click(await waitForRoleElement("button", "Back"));
  const restoredCodeInput = await screen.findByLabelText("Verification code");
  expect(restoredCodeInput).toHaveValue("");
  expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);
  expect(restoredCodeInput).toHaveAttribute("autocomplete", "one-time-code");
  expect(restoredCodeInput).toHaveAttribute("inputmode", "numeric");
  expect(restoredCodeInput).toHaveAttribute("maxlength", "6");
  expect(
    restoredCodeInput.parentElement?.querySelectorAll(
      '[aria-hidden="true"] > span',
    ),
  ).toHaveLength(6);
  const coolingDownButton = await waitForRoleElement(
    "button",
    "Didn't receive a code? Resend (30)",
  );
  expect(coolingDownButton).toBeDisabled();
  click(coolingDownButton);
  click(coolingDownButton);
  expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);

  mockNow(startedAt + 30_000, context.signal);
  const resendButton = await waitForRoleElement(
    "button",
    "Didn't receive a code? Resend",
  );
  expect(resendButton).toBeEnabled();
  click(resendButton);
  click(resendButton);

  await waitFor(() => {
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
  });
  const verifyButton = await waitForRoleElement("button", "Continue");
  await waitFor(() => {
    expect(verifyButton).toBeDisabled();
  });
  click(verifyButton);
  expect(mockedClerk.signInAttemptFirstFactor).not.toHaveBeenCalled();

  await act(async () => {
    resend.resolve(currentSignInResource());
    await resend.promise;
  });

  fireEvent.change(restoredCodeInput, { target: { value: "123456" } });
  const codeForm = containingForm(restoredCodeInput);
  fireEvent.submit(codeForm);
  fireEvent.submit(codeForm);

  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(resendButton).toBeDisabled();
  });
  click(resendButton);
  expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
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

test("An expired sign-in code can be corrected and resent safely", async () => {
  mockExpiredVerificationAttempt();
  mockIdentifierSubmission([emailCodeFactor()]);
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  const codeInput = await openVerificationCodeStep(
    "Email code to p***@example.com",
    "Check your email",
  );
  await expect(
    waitForRoleElement("button", "Use another method"),
  ).resolves.toBeVisible();

  await recoverExpiredCodeWithOneResend(codeInput);
});

test("Refreshing a prepared code step does not send another code", async () => {
  await setupRestoredPreparedStep({
    cooldownIdentity: "email-code:email_primary",
    factor: emailCodeFactor(),
    strategy: "email_code",
  });

  click(await waitForRoleElement("button", "Use another method"));
  await expect(
    screen.findByRole("heading", { name: "Use another method" }),
  ).resolves.toBeVisible();
  click(await waitForRoleElement("button", "Back"));
  await expect(
    screen.findByLabelText("Verification code"),
  ).resolves.toBeVisible();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

  await editRestoredIdentifier();
});

test("An edited restored email remains authoritative", async () => {
  const factors = [emailCodeFactor(), passwordFactor()];
  mockPreparedFirstFactor("email_code");
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    Reflect.deleteProperty(currentSignInResource(), "firstFactorVerification");
    return moveSignInToAsync({
      identifier: "person@example.com",
      status: "needs_first_factor",
      supportedFirstFactors: factors,
    });
  });
  await setupSignInPage({
    identifier: "person@example.com",
    status: "needs_first_factor",
    supportedFirstFactors: factors,
  });

  await screen.findByLabelText("Verification code");
  click(await waitForRoleElement("button", "Edit identifier"));
  const identifierInput = await screen.findByLabelText("Email address");
  expect(identifierInput).toHaveValue("person@example.com");
  await fill(identifierInput, "edited@example.com");

  fireEvent.submit(containingForm(identifierInput));

  await waitFor(() => {
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      identifier: "edited@example.com",
    });
  });
  click(await waitForRoleElement("button", "Edit identifier"));
  await expect(screen.findByLabelText("Email address")).resolves.toHaveValue(
    "edited@example.com",
  );
});

test("A failed email-code request leaves method selection usable", async () => {
  mockedClerk.signInPrepareFirstFactor.mockRejectedValue({
    errors: [{ longMessage: "We couldn't send a verification code." }],
  });
  mockIdentifierSubmission([passwordFactor(), emailCodeFactor()]);

  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");
  click(await waitForRoleElement("button", "Use another method"));

  const emailMethod = await waitForRoleElement(
    "button",
    "Email code to p***@example.com",
  );
  click(emailMethod);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(document.activeElement).toBe(alert);
  expect(
    screen.queryByText("We couldn't send a verification code."),
  ).toBeNull();
  expect(emailMethod).toBeVisible();
  expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
});

test("Leaving sign-in clears an unfinished password draft", async () => {
  mockIdentifierSubmission([passwordFactor()]);
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  const passwordInput = await screen.findByLabelText("Password");
  await fill(passwordInput, "route-secret");

  navigateToSignUp();
  await expect(
    screen.findByRole("region", { name: "Create your account" }),
  ).resolves.toBeVisible();

  act(() => {
    window.history.back();
  });
  click(await waitForRoleElement("button", "Sign in with your password"));

  await expect(screen.findByLabelText("Password")).resolves.toHaveValue("");
});

test("A visitor resets a forgotten password and signs in", async () => {
  const factors = [passwordFactor(), passwordResetFactor()];
  mockedClerk.signInPrepareFirstFactor.mockImplementation(() => {
    return currentSignInResourceAsync();
  });
  mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "needs_new_password",
      supportedFirstFactors: factors,
    });
  });
  mockedClerk.signInResetPassword.mockImplementation(() => {
    return moveSignInToAsync({
      createdSessionId: "session_reset",
      status: "complete",
    });
  });
  mockIdentifierSubmission(factors);

  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  click(await waitForRoleElement("button", "Forgot password?"));
  await expect(
    screen.findByRole("heading", { name: "Forgot Password?" }),
  ).resolves.toBeVisible();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
  expect(roleElement("link", "Sign up")).toBeUndefined();
  await expect(waitForRoleElement("button", "Get help")).resolves.toBeVisible();
  click(await waitForRoleElement("button", "Reset your password"));
  await waitFor(() => {
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledWith({
      emailAddressId: "email_primary",
      strategy: "reset_password_email_code",
    });
  });

  const codeInput = await screen.findByLabelText("Verification code");
  await fill(codeInput, "654321");
  fireEvent.submit(containingForm(codeInput));

  await waitFor(() => {
    expect(mockedClerk.signInAttemptFirstFactor).toHaveBeenCalledWith({
      code: "654321",
      strategy: "reset_password_email_code",
    });
  });

  const newPasswordInput = await screen.findByLabelText("New password");
  const confirmPasswordInput = screen.getByLabelText("Confirm password");
  const signOutOtherDevices = screen.getByRole("checkbox", {
    name: "Sign out of all other devices",
  });
  expect(signOutOtherDevices).toBeChecked();
  await expect(
    renderedCheckboxPresentation(signOutOtherDevices, context.signal),
  ).resolves.toStrictEqual({
    backgroundColor: "rgb(70 80 90)",
    borderColor: "rgb(70 80 90)",
    borderRadius: "6px",
    borderStyle: "solid",
    borderWidth: "1px",
    flexShrink: "0",
    height: "calc(4px * 4)",
    width: "calc(4px * 4)",
  });
  expect(
    screen.getByRole("region", { name: "Set new password" }),
  ).not.toHaveAttribute("aria-describedby");
  expect(roleElement("link", "Sign up")).toBeUndefined();
  const revealButtons = queryAllByRoleFast("button").filter((candidate) => {
    return candidate.getAttribute("aria-label") === "Show password";
  });
  expect(revealButtons).toHaveLength(2);
  const [revealNewPassword, revealConfirmation] = revealButtons;
  if (!revealNewPassword || !revealConfirmation) {
    throw new Error("Expected reveal controls for both password fields");
  }
  click(revealNewPassword);
  click(revealConfirmation);
  expect(newPasswordInput).toHaveAttribute("type", "text");
  expect(confirmPasswordInput).toHaveAttribute("type", "text");
  expect(mockedClerk.signInResetPassword).not.toHaveBeenCalled();
  await fill(newPasswordInput, "new-password");
  await fill(confirmPasswordInput, "different-password");
  fireEvent.submit(containingForm(newPasswordInput));

  const mismatchAlert = await screen.findByRole("alert");
  expect(mismatchAlert).toHaveTextContent("Passwords don't match.");
  expect(document.activeElement).toBe(mismatchAlert);
  await expect(
    renderedFocusedElementPresentation(mismatchAlert, context.signal),
  ).resolves.toStrictEqual({ boxShadow: "none" });
  expectNoFieldErrorAssociation(newPasswordInput);
  expectFieldErrorAssociation(confirmPasswordInput, mismatchAlert);
  expect(mockedClerk.signInResetPassword).not.toHaveBeenCalled();

  await fill(confirmPasswordInput, "new-password");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(newPasswordInput).toHaveValue("new-password");
  expect(confirmPasswordInput).toHaveValue("new-password");
  expectNoFieldErrorAssociation(newPasswordInput);
  expectNoFieldErrorAssociation(confirmPasswordInput);
  fireEvent.submit(containingForm(newPasswordInput));

  await waitFor(() => {
    expect(mockedClerk.signInResetPassword).toHaveBeenCalledWith({
      password: "new-password",
      signOutOfOtherSessions: true,
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
  await expect(
    screen.findByRole("heading", { name: "Sign-in complete" }),
  ).resolves.toBeVisible();
});

test("A visitor can keep other sessions active during password reset", async () => {
  const user = userEvent.setup({ delay: null });
  const factors = [passwordFactor(), passwordResetFactor()];
  mockedClerk.signInResetPassword.mockImplementation(() => {
    return moveSignInToAsync({
      createdSessionId: "session_reset_opt_out",
      status: "complete",
    });
  });
  await setupSignInPage({
    status: "needs_new_password",
    supportedFirstFactors: factors,
  });

  const newPasswordInput = await screen.findByLabelText("New password");
  const confirmPasswordInput = screen.getByLabelText("Confirm password");
  const signOutOtherDevices = screen.getByRole("checkbox", {
    name: "Sign out of all other devices",
  });
  expect(signOutOtherDevices).toBeChecked();
  await user.click(signOutOtherDevices);
  await waitFor(() => {
    expect(signOutOtherDevices).not.toBeChecked();
  });

  await fill(newPasswordInput, "new-password");
  await fill(confirmPasswordInput, "new-password");
  fireEvent.submit(containingForm(newPasswordInput));

  await expect(
    screen.findByRole("heading", { name: "Sign-in complete" }),
  ).resolves.toBeVisible();
  expect(mockedClerk.signInResetPassword).toHaveBeenCalledWith({
    password: "new-password",
    signOutOfOtherSessions: false,
  });
});

test("Back from password reset returns to a clean sign-in entry", async () => {
  const { expectedHref, url } = signUpSwitchContext();
  await setupSignInPage(
    {
      status: "needs_new_password",
      supportedFirstFactors: [passwordFactor(), passwordResetFactor()],
    },
    { url },
  );

  await expect(
    screen.findByRole("heading", { name: "Set new password" }),
  ).resolves.toBeVisible();
  expect(
    screen.queryByText(
      "For security reasons, it is required to reset your password.",
    ),
  ).not.toBeInTheDocument();
  click(await waitForRoleElement("button", "Back"));

  await expect(
    screen.findByRole("heading", { name: "Sign in to Okou" }),
  ).resolves.toBeVisible();
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  await expect(waitForRoleElement("link", "Sign up")).resolves.toHaveAttribute(
    "href",
    expectedHref,
  );
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
});

test("Sign-in help returns the visitor to the chooser they came from", async () => {
  mockAuthV2Capabilities({ appleOAuth: true, googleOAuth: true });
  mockIdentifierSubmission([
    passwordFactor(),
    emailCodeFactor(),
    passwordResetFactor(),
  ]);
  await setupSignInPage({ status: "needs_identifier" });
  await submitIdentifier("person@example.com");

  click(await waitForRoleElement("button", "Use another method"));
  click(await waitForRoleElement("button", "Get help"));

  await expect(
    screen.findByRole("heading", { name: "Get help" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByRole("region", { name: "Get help" }),
  ).toHaveAccessibleDescription(
    "If you have trouble signing into your account, email us and we will work with you to restore access as soon as possible.",
  );
  await expect(
    waitForRoleElement("link", "Email support"),
  ).resolves.toHaveAttribute("href", "mailto:support@vm0.ai");
  expect(roleElement("link", "Sign up")).toBeUndefined();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

  click(await waitForRoleElement("button", "Back"));
  await expect(
    screen.findByRole("heading", { name: "Use another method" }),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Email code to p***@example.com"),
  ).resolves.toBeVisible();

  click(await waitForRoleElement("button", "Back"));
  click(await waitForRoleElement("button", "Forgot password?"));
  click(await waitForRoleElement("button", "Get help"));
  await expect(
    screen.findByRole("heading", { name: "Get help" }),
  ).resolves.toBeVisible();
  click(await waitForRoleElement("button", "Back"));
  await expect(
    screen.findByRole("heading", { name: "Forgot Password?" }),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Reset your password"),
  ).resolves.toBeVisible();
  expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
});

test("An email lookup failure remains safe and retryable", async () => {
  mockedClerk.clientSignInCreate
    .mockRejectedValueOnce({
      errors: [
        {
          longMessage: "We couldn't find an account with that identifier.",
          meta: { paramName: "identifier" },
        },
      ],
    })
    .mockImplementationOnce(() => {
      return moveSignInToAsync({
        status: "needs_first_factor",
        supportedFirstFactors: [passwordFactor()],
      });
    });

  await setupSignInPage({ status: "needs_identifier" });

  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, "missing@example.com");
  fireEvent.submit(containingForm(identifierInput));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "This action couldn't be completed. Please try again later or contact support if this persists.",
  );
  expect(document.activeElement).toBe(alert);
  expectFieldErrorAssociation(identifierInput, alert);
  expect(
    Array.from(document.querySelectorAll("[id]")).filter((element) => {
      return element.id === alert.id;
    }),
  ).toHaveLength(1);
  expect(
    screen.queryByText("We couldn't find an account with that identifier."),
  ).toBeNull();
  expect(identifierInput).toBeVisible();
  expect(identifierInput).toHaveValue("missing@example.com");

  await fill(identifierInput, "retry@example.com");
  await waitFor(() => {
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  expect(identifierInput).toHaveValue("retry@example.com");
  expectNoFieldErrorAssociation(identifierInput);

  fireEvent.submit(containingForm(identifierInput));
  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
});

test("Okou account suspension errors use safe branded support information", async () => {
  mockedClerk.clientSignInCreate.mockRejectedValue({
    errors: [
      {
        code: "user_banned",
        longMessage: "Private provider account detail.",
        meta: { paramName: "identifier" },
      },
    ],
  });
  await setupSignInPage(
    { status: "needs_identifier" },
    {
      url: `https://app.vm0.ai/sign-in?redirect_url=${encodeURIComponent(
        "https://app.okou.ai/",
      )}`,
    },
  );

  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, "person@example.com");
  fireEvent.submit(containingForm(identifierInput));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Account access suspended because activity on this account violated the Okou Terms of Use. If you have questions, contact support@okou.ai.",
  );
  expect(screen.queryByText("Private provider account detail.")).toBeNull();
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Sign in to Okou",
  );
});

test("A transferable sign-in offers one contextual path to sign-up", async () => {
  const { expectedHref, url } = signUpSwitchContext();
  await setupSignInPage(
    {
      identifier: "person@example.com",
      isTransferable: true,
      status: "needs_first_factor",
      supportedFirstFactors: [passwordFactor()],
    },
    { url },
  );

  const signUp = await waitForRoleElement("link", "Sign up");
  expect(signUp).toHaveAttribute("href", expectedHref);
  expect(
    queryAllByRoleFast("link").filter((candidate) => {
      return candidate.textContent?.trim() === "Sign up";
    }),
  ).toHaveLength(1);

  click(await waitForRoleElement("button", "Use another method"));

  await expect(screen.findByLabelText("Email address")).resolves.toHaveValue(
    "",
  );
});

test("A completed sign-in does not offer a conflicting sign-up action", async () => {
  const activation = createDeferredPromise<void>(context.signal);
  mockedClerk.setActive.mockImplementation(() => {
    return activation.promise;
  });
  const pageReady = setupSignInPage({
    createdSessionId: "session_complete",
    status: "complete",
  });

  await waitFor(() => {
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  });
  expect(roleElement("link", "Sign up")).toBeUndefined();
  activation.resolve();
  await pageReady;
});

test("Invalid sign-in states fail closed with an explicit recovery path", async () => {
  await setupSignInPage({
    status: "needs_first_factor",
    supportedFirstFactors: [{ strategy: "oauth_github" }],
  });

  await expect(
    screen.findByRole("heading", { name: "Cannot sign in" }),
  ).resolves.toBeVisible();
  await expect(
    waitForRoleElement("button", "Use another method"),
  ).resolves.toBeVisible();
  expect(roleElement("link", "Sign up")).toBeUndefined();
});
