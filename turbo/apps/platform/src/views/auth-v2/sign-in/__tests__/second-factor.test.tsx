// @vitest-environment-options {"url":"https://app.vm0.ai/"}

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  mockedClerk,
  mockSignInResource,
  type MockedSignInFactor,
  type MockedSignInResourceState,
} from "../../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../../__tests__/page-helper.ts";
import { testContext } from "../../../../signals/__tests__/test-helpers.ts";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../../../signals/route.ts";

const context = testContext();
const EMAIL_FACTOR = {
  emailAddressId: "email_primary",
  safeIdentifier: "p***@example.com",
  strategy: "email_code",
} as const;
const PHONE_FACTOR = {
  phoneNumberId: "phone_primary",
  safeIdentifier: "+1 ••• ••• 0123",
  strategy: "phone_code",
} as const;
const MFA_FACTORS: readonly MockedSignInFactor[] = [
  { strategy: "totp" },
  PHONE_FACTOR,
  { strategy: "backup_code" },
  { strategy: "unknown_factor" },
];

function moveSignInTo(state: MockedSignInResourceState) {
  mockSignInResource(state);
  return mockedClerk.client.signIn;
}

function moveSignInToAsync(state: MockedSignInResourceState) {
  return Promise.resolve(moveSignInTo(state));
}

function button(name: string): HTMLElement {
  const element = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!element) {
    throw new Error(`Expected button named ${name}`);
  }
  return element;
}

function submit(input: HTMLElement): void {
  const form = input.closest("form");
  if (!form) {
    throw new Error("Expected a verification form");
  }
  fireEvent.submit(form);
}

function setupSignIn(state: MockedSignInResourceState): Promise<void> {
  mockSignInResource(state);
  return setupPage({
    context,
    host: "app.vm0.ai",
    path: `/sign-in/factor-two?redirect_url=${encodeURIComponent("https://app.vm0.ai/onboarding?source=mfa")}`,
    auth: null,
    env: { VITE_POSTHOG_KEY: "phc_platform_test" },
  });
}

test.each(["needs_second_factor", "needs_client_trust"])(
  "Password sign-in completes email verification with Clerk status %s",
  async (status) => {
    const verification =
      context.mocks.deferred<ReturnType<typeof moveSignInTo>>();
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      return moveSignInToAsync({
        identifier: "person@example.com",
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
      });
    });
    mockedClerk.signInAttemptFirstFactor.mockImplementation(() => {
      return moveSignInToAsync({
        status,
        supportedSecondFactors: [EMAIL_FACTOR],
      });
    });
    mockedClerk.signInPrepareSecondFactor.mockImplementation(() => {
      return moveSignInToAsync({
        status,
        supportedSecondFactors: [EMAIL_FACTOR],
        secondFactorVerificationStatus: "unverified",
        secondFactorVerificationStrategy: "email_code",
      });
    });
    mockedClerk.signInAttemptSecondFactor.mockReturnValue(verification.promise);
    await setupSignIn({ status: "needs_identifier" });
    const identifier = await screen.findByLabelText("Email address");
    await fill(identifier, "person@example.com");
    submit(identifier);
    const password = await screen.findByLabelText("Password");
    await fill(password, "correct-password");
    submit(password);

    const code = await screen.findByLabelText("Verification code");
    expect(screen.getByText(EMAIL_FACTOR.safeIdentifier)).toBeVisible();
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
    expect(
      mockedClerk.signInPrepareSecondFactor,
    ).toHaveBeenCalledExactlyOnceWith({
      emailAddressId: EMAIL_FACTOR.emailAddressId,
      strategy: "email_code",
    });
    await fill(code, "424242");
    submit(code);
    submit(code);
    await waitFor(() => {
      return expect(button("Continue")).toBeDisabled();
    });
    await act(async () => {
      verification.resolve(
        moveSignInTo({ status: "complete", createdSessionId: "session_mfa" }),
      );
      await verification.promise;
    });
    await waitFor(() => {
      return expect(location.pathname).toBe("/onboarding");
    });
    expect(location.search).toBe("?source=mfa");
    expect(
      mockedClerk.signInAttemptSecondFactor,
    ).toHaveBeenCalledExactlyOnceWith({
      code: "424242",
      strategy: "email_code",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
  },
);

test("An incorrect authenticator code can be retried without sending a message", async () => {
  const analytics = context.mocks.posthog();
  mockedClerk.signInAttemptSecondFactor
    .mockRejectedValueOnce({
      errors: [
        { code: "form_code_incorrect", message: "Private provider message" },
      ],
    })
    .mockImplementationOnce(() => {
      return moveSignInToAsync({
        status: "complete",
        createdSessionId: "session_totp",
      });
    });
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: MFA_FACTORS,
  });
  const code = await screen.findByLabelText("Verification code");
  expect(
    screen.getByRole("region", {
      description: "Enter the code from your authenticator app.",
    }),
  ).toBeVisible();
  expect(
    queryAllByRoleFast("button").some((element) => {
      return element.textContent?.includes("Resend");
    }),
  ).toBeFalsy();
  await fill(code, "111111");
  submit(code);
  const error = await screen.findByRole("alert");
  expect(code).toHaveAttribute("aria-invalid", "true");
  expect(code).toHaveAccessibleDescription(error.textContent ?? "");
  expect(error).toHaveTextContent("That code is incorrect. Try again.");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  await waitFor(() => {
    return expect(error).toHaveFocus();
  });
  fireEvent.change(code, { target: { value: "654321" } });
  expect(code).toHaveValue("654321");
  submit(code);
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenLastCalledWith({
    code: "654321",
    strategy: "totp",
  });
  expect(mockedClerk.signInPrepareSecondFactor).not.toHaveBeenCalled();
  const diagnostics = analytics.events.filter((event) => {
    return event.name === "auth_v2_diagnostic";
  });
  expect(
    diagnostics.some((event) => {
      return (
        event.properties?.method === "totp" &&
        event.properties.step === "second-factor"
      );
    }),
  ).toBeTruthy();
  expect(JSON.stringify(diagnostics)).not.toContain("654321");
  expect(JSON.stringify(diagnostics)).not.toContain("Private provider message");
});

test("MFA methods switch between SMS and unrestricted backup codes without resending", async () => {
  mockedClerk.signInPrepareSecondFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "needs_second_factor",
      supportedSecondFactors: MFA_FACTORS,
      secondFactorVerificationStatus: "unverified",
      secondFactorVerificationStrategy: "phone_code",
    });
  });
  mockedClerk.signInAttemptSecondFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "complete",
      createdSessionId: "session_backup",
    });
  });
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: MFA_FACTORS,
  });
  await screen.findByLabelText("Verification code");
  click(button("Use another method"));
  await screen.findByRole("region", {
    description: "Choose how to verify your sign-in.",
  });
  click(button(`Send a text message to ${PHONE_FACTOR.safeIdentifier}`));
  const phoneCode = await screen.findByLabelText("Verification code");
  expect(screen.getByText(PHONE_FACTOR.safeIdentifier)).toBeVisible();
  await fill(phoneCode, "123456");
  click(button("Use another method"));
  await screen.findByRole("region", {
    description: "Choose how to verify your sign-in.",
  });
  click(button("Use a backup code"));
  const backupCode = await screen.findByLabelText("Backup code");
  expect(backupCode).toHaveValue("");
  expect(backupCode).not.toHaveAttribute("maxLength");
  click(button("Use another method"));
  await screen.findByRole("region", {
    description: "Choose how to verify your sign-in.",
  });
  click(button(`Send a text message to ${PHONE_FACTOR.safeIdentifier}`));
  await screen.findByLabelText("Verification code");
  expect(mockedClerk.signInPrepareSecondFactor).toHaveBeenCalledExactlyOnceWith(
    {
      phoneNumberId: PHONE_FACTOR.phoneNumberId,
      strategy: "phone_code",
    },
  );
  click(button("Use another method"));
  await screen.findByRole("region", {
    description: "Choose how to verify your sign-in.",
  });
  click(button("Use a backup code"));
  const backup = await screen.findByLabelText("Backup code");
  await fill(backup, "AbCd-1234-efGH");
  expect(backup).toHaveValue("AbCd-1234-efGH");
  submit(backup);
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenCalledExactlyOnceWith(
    {
      code: "AbCd-1234-efGH",
      strategy: "backup_code",
    },
  );
});

test("A refreshed second-factor route resumes the prepared SMS challenge", async () => {
  mockedClerk.signInAttemptSecondFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "complete",
      createdSessionId: "session_phone",
    });
  });
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: [EMAIL_FACTOR, PHONE_FACTOR],
    secondFactorVerificationStatus: "unverified",
    secondFactorVerificationStrategy: "phone_code",
  });
  const code = await screen.findByLabelText("Verification code");
  expect(screen.getByText(PHONE_FACTOR.safeIdentifier)).toBeVisible();
  expect(mockedClerk.signInPrepareSecondFactor).not.toHaveBeenCalled();
  await fill(code, "424242");
  submit(code);
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenCalledExactlyOnceWith(
    {
      code: "424242",
      strategy: "phone_code",
    },
  );
});

test("An expired email challenge can be resent and completed", async () => {
  mockedClerk.signInPrepareSecondFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "needs_second_factor",
      supportedSecondFactors: [EMAIL_FACTOR],
      secondFactorVerificationStrategy: "email_code",
      secondFactorVerificationStatus: "unverified",
    });
  });
  mockedClerk.signInAttemptSecondFactor.mockImplementation(() => {
    return moveSignInToAsync({
      status: "complete",
      createdSessionId: "session_resent",
    });
  });
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: [EMAIL_FACTOR],
    secondFactorVerificationStrategy: "email_code",
    secondFactorVerificationStatus: "expired",
  });
  const code = await screen.findByLabelText("Verification code");
  expect(button("Continue")).toBeDisabled();
  expect(button("Didn't receive a code? Resend")).toBeEnabled();
  click(button("Didn't receive a code? Resend"));
  await waitFor(() => {
    return expect(button("Continue")).toBeEnabled();
  });
  await fill(code, "424242");
  submit(code);
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signInPrepareSecondFactor).toHaveBeenCalledTimes(1);
});

test("A timed-out authenticator code does not require an unavailable resend action", async () => {
  mockedClerk.signInAttemptSecondFactor
    .mockRejectedValueOnce({
      errors: [{ code: "verification_expired" }],
    })
    .mockImplementationOnce(() => {
      return moveSignInToAsync({
        status: "complete",
        createdSessionId: "session_totp_retry",
      });
    });
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: [{ strategy: "totp" }],
  });
  const code = await screen.findByLabelText("Verification code");
  await fill(code, "111111");
  submit(code);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "This code is no longer valid. Enter a new code.",
  );
  expect(button("Continue")).toBeEnabled();
  await waitFor(() => {
    return expect(screen.getByRole("alert")).toHaveFocus();
  });
  fireEvent.change(code, { target: { value: "222222" } });
  expect(code).toHaveValue("222222");
  submit(code);
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenLastCalledWith({
    code: "222222",
    strategy: "totp",
  });
});

test("Leaving sign-in during second-factor verification does not activate the late session", async () => {
  const verification =
    context.mocks.deferred<ReturnType<typeof moveSignInTo>>();
  mockedClerk.signInAttemptSecondFactor.mockReturnValue(verification.promise);
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: [{ strategy: "totp" }],
  });
  const code = await screen.findByLabelText("Verification code");
  await fill(code, "424242");
  submit(code);
  await waitFor(() => {
    return expect(button("Continue")).toBeDisabled();
  });

  context.store.set(detachedNavigateTo$, ROUTES.signUp);
  await expect(
    screen.findByRole("region", { name: "Create your account" }),
  ).resolves.toBeVisible();
  await act(async () => {
    verification.resolve(
      moveSignInTo({ status: "complete", createdSessionId: "session_late" }),
    );
    await verification.promise;
  });
  expect(location.pathname).toBe("/sign-up");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
});

test("Unsupported-only second-factor challenges remain blocked", async () => {
  await setupSignIn({
    status: "needs_second_factor",
    supportedSecondFactors: [{ strategy: "unknown_factor" }],
  });
  await expect(
    screen.findByRole("heading", { name: "Cannot sign in" }),
  ).resolves.toBeVisible();
  expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
  expect(mockedClerk.signInPrepareSecondFactor).not.toHaveBeenCalled();
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(button("Use another method"));
  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
});
