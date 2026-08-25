import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
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
import { createDeferredPromise } from "../../../../signals/utils.ts";
import { mockNow } from "../../../../lib/time.ts";

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
): void {
  mockSignInResource(state);
  const url = new URL(options.url ?? "https://app.vm0.ai/v2/sign-in");
  context.mocks.browser.url(url.toString());
  detachedSetupPage({
    context,
    path: `${url.pathname}${url.search}${url.hash}`,
    session: null,
    user: options.user ?? null,
  });
}

function useGermanLocale(): void {
  document.documentElement.lang = "de-DE";
  context.mocks.data.userPreferences({
    locale: "de-DE",
    supportedLocales: ["de-DE", "en-US"],
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
    expectedHref: `/v2/sign-up?${searchParams.toString()}${hash}`,
    url: `https://app.vm0.ai/v2/sign-in?${searchParams.toString()}${hash}`,
  };
}

function createStalledGoogleOneTapScript(): HTMLScriptElement {
  const script = document.createElement("script");
  script.dataset.authV2GoogleOneTap = "true";
  document.head.appendChild(script);
  return script;
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
    expect(loadingState).toHaveTextContent(
      "Checking what your account needs next.",
    );
    expect(roleElement("link", "Sign up")).toBeUndefined();

    await act(async () => {
      clerkLoad.resolve(undefined);
      await clerkLoad.promise;
    });

    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toBeVisible();
  });

  it("starts a fresh identifier request with an empty draft", async () => {
    setupSignInPage({
      identifier: "previous@example.com",
      status: "needs_identifier",
    });

    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toHaveValue("");
  });

  it("preserves exact navigation context in the ordinary sign-up switch", async () => {
    const { expectedHref, url } = signUpSwitchContext();
    setupSignInPage({ status: "needs_identifier" }, { url });

    const signUp = await waitForRoleElement("link", "Sign up");
    expect(signUp).toHaveAttribute("href", expectedHref);
    expect(signUp.parentElement).toHaveTextContent(
      "Don’t have an account? Sign up",
    );
  });

  it("discovers password factors, coalesces duplicate submits, and activates once", async () => {
    const user = userEvent.setup({ delay: null });
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
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Sign in to VM0" }),
    );
    fireEvent.click(passwordMethod);

    const passwordInput = await screen.findByLabelText("Password");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Sign in to VM0" }),
    );
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
      navigate: expect.any(Function),
      session: "session_password",
    });
  });

  it("associates only typed password errors and clears them on change", async () => {
    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", [passwordFactor()]);
    fireEvent.click(
      await waitForRoleElement("button", "Sign in with your password"),
    );

    const passwordInput = await screen.findByLabelText("Password");
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

    fireEvent.change(passwordInput, { target: { value: "first-attempt" } });
    fireEvent.submit(containingForm(passwordInput));

    const unrelatedAlert = await screen.findByRole("alert");
    expect(document.activeElement).toBe(unrelatedAlert);
    expectNoFieldErrorAssociation(passwordInput);
    expect(
      screen.queryByText("Private identifier provider detail."),
    ).toBeNull();

    fireEvent.change(passwordInput, { target: { value: "second-attempt" } });
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

    fireEvent.change(passwordInput, { target: { value: "retry-password" } });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(passwordInput).toHaveValue("retry-password");
    expectNoFieldErrorAssociation(passwordInput);
  });

  it("hands Google OAuth to Clerk once with typed callback and completion URLs", async () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=oauth";
    const authSearch = new URLSearchParams({
      redirect_url: redirectUrl,
      utm_campaign: "oauth",
    });
    const authHash = "#/?step=start";
    mockAuthV2Capabilities({ googleOAuth: true });
    setupSignInPage(
      { status: "needs_identifier" },
      {
        url: `https://app.vm0.ai/v2/sign-in?${authSearch.toString()}${authHash}`,
      },
    );

    const google = await waitForRoleElement("button", "Continue with Google");
    fireEvent.click(google);
    fireEvent.click(google);

    await waitFor(() => {
      expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledWith({
      continueSignIn: true,
      continueSignUp: false,
      redirectUrl: `/v2/sign-in/sso-callback?${authSearch.toString()}${authHash}`,
      redirectUrlComplete: redirectUrl,
      strategy: "oauth_google",
    });
  });

  it("recovers a Google OAuth callback reload without activating twice", async () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=callback";
    mockSignInResource({
      createdSessionId: "session_oauth",
      status: "complete",
    });
    mockedClerk.setActive.mockResolvedValue(undefined);
    mockedClerk.handleRedirectCallback.mockImplementation(async (params) => {
      await mockedClerk.setActive({
        redirectUrl: params?.signInForceRedirectUrl ?? undefined,
        session: "session_oauth",
      });
    });

    setupSignInPage(
      {
        createdSessionId: "session_oauth",
        status: "complete",
      },
      {
        url: `https://app.vm0.ai/v2/sign-in/sso-callback?redirect_url=${encodeURIComponent(redirectUrl)}`,
      },
    );

    await waitFor(() => {
      expect(mockedClerk.handleRedirectCallback).toHaveBeenCalledTimes(1);
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.handleRedirectCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        firstFactorUrl: expect.stringContaining("/v2/sign-in/factor-one"),
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
  });

  it("exchanges one Google One Tap credential only on the exact base route", async () => {
    mockAuthV2Capabilities({
      googleOAuth: true,
      googleOneTapClientId: "google-client-id",
    });
    mockGoogleOneTapCredential("google-one-tap-token");
    mockedClerk.clientSignInCreate.mockImplementation((params) => {
      if (params.strategy === "google_one_tap") {
        return Promise.resolve(
          moveSignInTo({
            createdSessionId: "session_one_tap",
            status: "complete",
          }),
        );
      }
      return Promise.resolve(currentSignInResource());
    });

    setupSignInPage({ status: "needs_identifier" });

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

  it.each(["dismissed", "skipped"] as const)(
    "settles a FedCM %s moment without legacy notification methods",
    async (momentType) => {
      mockAuthV2Capabilities({
        googleOAuth: true,
        googleOneTapClientId: "google-client-id",
      });
      mockGoogleOneTapCredential(null);
      mockedGoogleOneTap.prompt.mockImplementation((callback) => {
        callback({
          getMomentType: () => {
            return momentType;
          },
        });
      });

      setupSignInPage({ status: "needs_identifier" });

      await waitFor(() => {
        expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
      });
      expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("ignores a legacy display moment until a terminal moment arrives", async () => {
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

    setupSignInPage({ status: "needs_identifier" });

    await waitFor(() => {
      expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels an aborted FedCM prompt and ignores late credential events", async () => {
    mockAuthV2Capabilities({
      googleOAuth: true,
      googleOneTapClientId: "google-client-id",
    });
    mockGoogleOneTapCredential(null);
    mockedGoogleOneTap.prompt.mockImplementation(() => {});

    setupSignInPage({ status: "needs_identifier" });

    await waitFor(() => {
      expect(mockedGoogleOneTap.prompt).toHaveBeenCalledTimes(1);
    });
    const initializeOptions =
      mockedGoogleOneTap.initialize.mock.calls.at(-1)?.[0];
    const promptCallback = mockedGoogleOneTap.prompt.mock.calls.at(-1)?.[0];
    if (!initializeOptions || !promptCallback) {
      throw new Error("Expected Google One Tap callbacks to be registered");
    }

    fireEvent.click(await waitForRoleElement("link", "Use current sign-in"));
    await expect(
      screen.findByTestId("clerk-sign-in"),
    ).resolves.toBeInTheDocument();
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

  it("does not start Google One Tap on a nested sign-in route", async () => {
    mockAuthV2Capabilities({
      googleOAuth: true,
      googleOneTapClientId: "google-client-id",
    });
    mockGoogleOneTapCredential("google-one-tap-token");

    setupSignInPage(
      { status: "needs_identifier" },
      { url: "https://app.vm0.ai/v2/sign-in/factor-one" },
    );

    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toBeVisible();
    expect(mockedGoogleOneTap.initialize).not.toHaveBeenCalled();
    expect(mockedGoogleOneTap.prompt).not.toHaveBeenCalled();
    expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
  });

  it("retries Google One Tap after a script failure and back navigation", async () => {
    mockAuthV2Capabilities({
      googleOAuth: true,
      googleOneTapClientId: "google-client-id",
    });
    const failedScript = createStalledGoogleOneTapScript();
    setupSignInPage({ status: "needs_identifier" });

    // Script loading is a browser resource boundary and cannot be triggered
    // through a rendered control, so dispatch its terminal event directly.
    await screen.findByLabelText("Email address or username");
    fireEvent.error(failedScript);

    await waitFor(() => {
      expect(failedScript).not.toBeInTheDocument();
    });
    await expect(screen.findByRole("alert")).resolves.toBeVisible();

    fireEvent.click(await waitForRoleElement("link", "Use current sign-in"));
    await expect(
      screen.findByTestId("clerk-sign-in"),
    ).resolves.toBeInTheDocument();

    const retryScript = createStalledGoogleOneTapScript();
    act(() => {
      window.history.back();
    });
    await screen.findByLabelText("Email address or username");
    expect(retryScript).not.toBe(failedScript);

    mockGoogleOneTapCredential("retry-google-one-tap-token");
    mockedClerk.clientSignInCreate.mockImplementation((params) => {
      if (params.strategy === "google_one_tap") {
        return Promise.resolve(
          moveSignInTo({
            createdSessionId: "session_one_tap_retry",
            status: "complete",
          }),
        );
      }
      return Promise.resolve(currentSignInResource());
    });
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

  it.each([
    {
      clerkError: {
        code: "passkey_retrieval_cancelled",
        message: "The passkey request was cancelled.",
      },
      expectedMessage: "Passkey verification was cancelled or timed out.",
      name: "user cancellation",
    },
    {
      clerkError: {
        code: "passkey_not_supported",
        message: "This device does not support passkeys.",
      },
      expectedMessage: "Passkeys are not supported on this device.",
      name: "an unavailable device",
    },
    {
      clerkError: {
        code: "passkey_retrieval_failed",
        message: "Your passkey could not be verified.",
      },
      expectedMessage:
        "This action couldn't be completed. Please try again later or contact support if this persists.",
      name: "a verification error",
    },
  ])("keeps another enabled method available after $name", async (testCase) => {
    mockAuthV2Capabilities({ googleOAuth: true, passkey: true });
    mockedClerk.signInAuthenticateWithPasskey.mockRejectedValue(
      testCase.clerkError,
    );
    setupSignInPage({
      status: "needs_first_factor",
      supportedFirstFactors: [googleOAuthFactor(), passkeyFactor()],
    });

    const passkey = await waitForRoleElement(
      "button",
      "Sign in with your passkey",
    );
    fireEvent.click(passkey);
    fireEvent.click(passkey);

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      testCase.expectedMessage,
    );
    expect(screen.queryByText(testCase.clerkError.message)).toBeNull();
    expect(mockedClerk.signInAuthenticateWithPasskey).toHaveBeenCalledTimes(1);
    const google = await waitForRoleElement("button", "Continue with Google");
    expect(google).toBeVisible();
    expect(passkey).toBeVisible();

    fireEvent.click(google);
    await waitFor(() => {
      expect(mockedClerk.signInAuthenticateWithRedirect).toHaveBeenCalledTimes(
        1,
      );
    });
  });

  it("selects an existing Clerk account once", async () => {
    const activation = createDeferredPromise<void>(context.signal);
    mockedClerk.setActive.mockImplementation(async (params) => {
      await activation.promise;
      await params.navigate?.({
        decorateUrl: (url) => {
          return url;
        },
        session: {
          id: "session_ada",
          status: "active",
          user: { organizationMemberships: [] },
        },
      });
    });
    setupSignInPage(
      { status: "needs_identifier" },
      {
        user: {
          clientSessions: [
            {
              id: "session_ada",
              status: "active",
              user: {
                fullName: "Ada Lovelace",
                primaryEmailAddress: { emailAddress: "ada@example.com" },
              },
            },
            {
              id: "session_grace",
              status: "active",
              user: {
                fullName: "Grace Hopper",
                primaryEmailAddress: { emailAddress: "grace@example.com" },
              },
            },
          ],
          email: "ada@example.com",
          fullName: "Ada Lovelace",
          id: "user_ada",
        },
      },
    );

    await expect(
      screen.findByRole("heading", { name: "Choose an account" }),
    ).resolves.toBeVisible();
    const adaAccount = queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.includes("Ada Lovelace");
    });
    if (!adaAccount) {
      throw new Error("Ada Lovelace account button not found");
    }
    fireEvent.click(adaAccount);
    fireEvent.click(adaAccount);

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "session_ada",
    });

    await act(async () => {
      activation.resolve(undefined);
      await activation.promise;
    });
  });

  it("can fall back from existing Clerk accounts to a new sign-in", async () => {
    setupSignInPage(
      {
        identifier: "previous@example.com",
        status: "needs_identifier",
      },
      {
        user: {
          clientSessions: [
            {
              id: "session_ada",
              status: "active",
              user: {
                fullName: "Ada Lovelace",
                primaryEmailAddress: { emailAddress: "ada@example.com" },
              },
            },
          ],
          email: "ada@example.com",
          fullName: "Ada Lovelace",
          id: "user_ada",
        },
      },
    );

    fireEvent.click(await waitForRoleElement("button", "Add account"));

    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toHaveValue("");
  });

  it("prepares and resends one email code per concurrent user action", async () => {
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
    await waitFor(() => {
      expect(emailMethod).toBeDisabled();
    });
    expect(
      screen.queryByLabelText("Verification code"),
    ).not.toBeInTheDocument();

    await act(async () => {
      prepare.resolve(currentSignInResource());
      await prepare.promise;
    });

    const codeInput = await screen.findByLabelText("Verification code");
    const coolingDownButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend (30s)",
    );
    expect(coolingDownButton).toBeDisabled();
    fireEvent.click(coolingDownButton);
    fireEvent.click(coolingDownButton);
    expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(1);

    mockNow(startedAt + 30_000, context.signal);
    const resendButton = await waitForRoleElement(
      "button",
      "Didn't receive a code? Resend",
    );
    expect(resendButton).toBeEnabled();
    fireEvent.click(resendButton);
    fireEvent.click(resendButton);

    await waitFor(() => {
      expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
    });
    const verifyButton = await waitForRoleElement("button", "Verify");
    await waitFor(() => {
      expect(verifyButton).toBeDisabled();
    });
    fireEvent.click(verifyButton);
    expect(mockedClerk.signInAttemptFirstFactor).not.toHaveBeenCalled();

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
    await waitFor(() => {
      expect(resendButton).toBeDisabled();
    });
    fireEvent.click(resendButton);
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

  it.each([
    {
      factor: emailCodeFactor(),
      method: "Email code to p***@example.com",
      name: "email verification",
    },
    {
      factor: passwordResetFactor(),
      method: "Reset your password",
      name: "password reset",
    },
  ])("recovers an expired $name code with one resend", async (testCase) => {
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

    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", [testCase.factor]);
    fireEvent.click(await waitForRoleElement("button", testCase.method));

    const codeInput = await screen.findByLabelText("Verification code");
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
    fireEvent.click(resend);
    fireEvent.click(resend);

    await waitFor(() => {
      expect(mockedClerk.signInPrepareFirstFactor).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expectNoFieldErrorAssociation(codeInput);
    });
    expect(codeInput).toHaveValue("");
  });

  it.each([
    {
      factor: emailCodeFactor(),
      method: "Email code to p***@example.com",
      name: "email-code",
      strategy: "email_code" as const,
    },
    {
      factor: passwordResetFactor(),
      method: "Reset your password",
      name: "password-reset-code",
      strategy: "reset_password_email_code" as const,
    },
  ])(
    "restores a prepared $name step and its editable identifier without another initial dispatch",
    async (testCase) => {
      mockPreparedFirstFactor(testCase.strategy);
      setupSignInPage({
        identifier: "person@example.com",
        status: "needs_first_factor",
        supportedFirstFactors: [testCase.factor, passwordFactor()],
      });

      await expect(
        screen.findByLabelText("Verification code"),
      ).resolves.toBeVisible();
      expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

      fireEvent.click(screen.getByLabelText("Toggle theme"));
      expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
      fireEvent.click(await waitForRoleElement("button", "Back"));
      fireEvent.click(await waitForRoleElement("button", testCase.method));
      await expect(
        screen.findByLabelText("Verification code"),
      ).resolves.toBeVisible();
      expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();

      fireEvent.click(await waitForRoleElement("button", "Back"));
      fireEvent.click(await waitForRoleElement("button", "Edit identifier"));
      await expect(
        screen.findByLabelText("Email address or username"),
      ).resolves.toHaveValue("person@example.com");
      expect(mockedClerk.signInPrepareFirstFactor).not.toHaveBeenCalled();
    },
  );

  it("keeps an edited restored identifier authoritative over a stale resource snapshot", async () => {
    const factors = [emailCodeFactor(), passwordFactor()];
    mockPreparedFirstFactor("email_code");
    setupSignInPage({
      identifier: "person@example.com",
      status: "needs_first_factor",
      supportedFirstFactors: factors,
    });

    await screen.findByLabelText("Verification code");
    fireEvent.click(await waitForRoleElement("button", "Back"));
    fireEvent.click(await waitForRoleElement("button", "Edit identifier"));
    const identifierInput = await screen.findByLabelText(
      "Email address or username",
    );
    expect(identifierInput).toHaveValue("person@example.com");
    fireEvent.change(identifierInput, {
      target: { value: "edited@example.com" },
    });

    Reflect.deleteProperty(currentSignInResource(), "firstFactorVerification");
    mockedClerk.clientSignInCreate.mockResolvedValue(
      moveSignInTo({
        identifier: "person@example.com",
        status: "needs_first_factor",
        supportedFirstFactors: factors,
      }),
    );
    fireEvent.submit(containingForm(identifierInput));

    await waitFor(() => {
      expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
        identifier: "edited@example.com",
      });
    });
    fireEvent.click(await waitForRoleElement("button", "Edit identifier"));
    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toHaveValue("edited@example.com");
  });

  it("keeps factor selection usable when email-code preparation fails", async () => {
    mockedClerk.signInPrepareFirstFactor.mockRejectedValue({
      errors: [{ longMessage: "We couldn't send a verification code." }],
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

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This action couldn't be completed. Please try again later or contact support if this persists.",
    );
    expect(document.activeElement).toBe(alert);
    expect(
      screen.queryByText("We couldn't send a verification code."),
    ).toBeNull();
    expect(emailMethod).toBeVisible();
    expect(
      screen.queryByLabelText("Verification code"),
    ).not.toBeInTheDocument();
  });

  it("releases credential drafts when the sign-in route is left", async () => {
    setupSignInPage({ status: "needs_identifier" });
    await submitIdentifier("person@example.com", [passwordFactor()]);

    fireEvent.click(
      await waitForRoleElement("button", "Sign in with your password"),
    );
    const passwordInput = await screen.findByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "route-secret" } });

    fireEvent.click(await waitForRoleElement("link", "Use current sign-in"));
    await expect(
      screen.findByTestId("clerk-sign-in"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("clerk-google-one-tap")).toBeInTheDocument();

    act(() => {
      window.history.back();
    });
    fireEvent.click(
      await waitForRoleElement("button", "Sign in with your password"),
    );

    await expect(screen.findByLabelText("Password")).resolves.toHaveValue("");
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
    expect(document.querySelector('[class*="cl-"]')).not.toBeInTheDocument();
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
    const revealButtons = queryAllByRoleFast("button").filter((candidate) => {
      return candidate.getAttribute("aria-label") === "Show password";
    });
    expect(revealButtons).toHaveLength(2);
    const [revealNewPassword, revealConfirmation] = revealButtons;
    if (!revealNewPassword || !revealConfirmation) {
      throw new Error("Expected reveal controls for both password fields");
    }
    fireEvent.click(revealNewPassword);
    fireEvent.click(revealConfirmation);
    expect(newPasswordInput).toHaveAttribute("type", "text");
    expect(confirmPasswordInput).toHaveAttribute("type", "text");
    expect(mockedClerk.signInResetPassword).not.toHaveBeenCalled();
    fireEvent.change(newPasswordInput, { target: { value: "new-password" } });
    fireEvent.change(confirmPasswordInput, {
      target: { value: "different-password" },
    });
    fireEvent.submit(containingForm(newPasswordInput));

    const mismatchAlert = await screen.findByRole("alert");
    expect(mismatchAlert).toHaveTextContent("Passwords don't match.");
    expect(document.activeElement).toBe(mismatchAlert);
    expectFieldErrorAssociation(newPasswordInput, mismatchAlert);
    expectFieldErrorAssociation(confirmPasswordInput, mismatchAlert);
    expect(mockedClerk.signInResetPassword).not.toHaveBeenCalled();

    fireEvent.change(confirmPasswordInput, {
      target: { value: "new-password" },
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(newPasswordInput).toHaveValue("new-password");
    expect(confirmPasswordInput).toHaveValue("new-password");
    expectNoFieldErrorAssociation(newPasswordInput);
    expectNoFieldErrorAssociation(confirmPasswordInput);
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
    mockedClerk.clientSignInCreate.mockRejectedValueOnce({
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

    fireEvent.change(identifierInput, {
      target: { value: "retry@example.com" },
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(identifierInput).toHaveValue("retry@example.com");
    expectNoFieldErrorAssociation(identifierInput);

    const nextResource = moveSignInTo({
      status: "needs_first_factor",
      supportedFirstFactors: [passwordFactor()],
    });
    mockedClerk.clientSignInCreate.mockResolvedValueOnce(nextResource);
    fireEvent.submit(containingForm(identifierInput));
    await expect(
      waitForRoleElement("button", "Sign in with your password"),
    ).resolves.toBeVisible();
  });

  it("substitutes the Okou brand and support address in safe errors", async () => {
    mockedClerk.clientSignInCreate.mockRejectedValue({
      errors: [
        {
          code: "user_banned",
          longMessage: "Private provider account detail.",
          meta: { paramName: "identifier" },
        },
      ],
    });
    setupSignInPage(
      { status: "needs_identifier" },
      { url: "https://app.okou.ai/v2/sign-in" },
    );

    const identifierInput = await screen.findByLabelText(
      "Email address or username",
    );
    fireEvent.change(identifierInput, {
      target: { value: "person@example.com" },
    });
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

  it("substitutes the Okou brand in German entry and password subtitles", async () => {
    useGermanLocale();
    setupSignInPage(
      { status: "needs_identifier" },
      { url: "https://app.okou.ai/v2/sign-in" },
    );

    const identifierInput = await screen.findByLabelText(
      "E-Mail-Adresse oder Benutzername",
    );
    expect(
      screen.getByRole("region", { name: "Bei Okou anmelden" }),
    ).toHaveAccessibleDescription("weiter zu Okou");

    const nextResource = moveSignInTo({
      status: "needs_first_factor",
      supportedFirstFactors: [passwordFactor()],
    });
    mockedClerk.clientSignInCreate.mockResolvedValue(nextResource);
    fireEvent.change(identifierInput, {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(containingForm(identifierInput));

    fireEvent.click(
      await waitForRoleElement(
        "button",
        "Melden Sie sich mit Ihrem Passwort an",
      ),
    );
    await screen.findByLabelText("Passwort");
    expect(
      screen.getByRole("region", { name: "Bei Okou anmelden" }),
    ).toHaveAccessibleDescription("weiter zu Okou");
    expect(document.body).not.toHaveTextContent("{{brandName}}");
  });

  it("renders a transfer state without implementing sign-up", async () => {
    setupSignInPage({
      identifier: "person@example.com",
      isTransferable: true,
      status: "needs_first_factor",
      supportedFirstFactors: [passwordFactor()],
    });

    const signUp = await waitForRoleElement("link", "Sign up");
    expect(signUp).toHaveAttribute(
      "href",
      "/v2/sign-up?redirect_url=https%3A%2F%2Fapp.vm0.ai",
    );
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();

    fireEvent.click(await waitForRoleElement("button", "Use another method"));
    await expect(
      screen.findByLabelText("Email address or username"),
    ).resolves.toHaveValue("");
  });

  it("preserves exact navigation context in the transfer sign-up action", async () => {
    const { expectedHref, url } = signUpSwitchContext();
    setupSignInPage(
      {
        isTransferable: true,
        status: "needs_identifier",
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
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
  });

  it("does not render the ordinary sign-up switch while completing", async () => {
    const activation = createDeferredPromise<void>(context.signal);
    mockedClerk.setActive.mockImplementation(() => {
      return activation.promise;
    });
    setupSignInPage({
      createdSessionId: "session_complete",
      status: "complete",
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
    });
    expect(roleElement("link", "Sign up")).toBeUndefined();
  });

  it.each([
    {
      name: "an unsupported factor set",
      state: {
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "oauth_github" }],
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
    expect(roleElement("link", "Sign up")).toBeUndefined();
  });
});
