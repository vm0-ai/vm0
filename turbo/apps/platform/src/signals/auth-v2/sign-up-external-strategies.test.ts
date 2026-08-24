import type { Clerk } from "@clerk/clerk-js";
import type { SignUpResource } from "@clerk/react/types";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearMockedAuthOnAbort,
  mockAuthV2Capabilities,
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
} from "../../__tests__/mock-auth.ts";
import { testContext } from "../__tests__/test-helpers.ts";
import { resolveAuthV2PlatformContext } from "./platform-context.ts";
import {
  discoverAuthV2SignUpExternalCapabilities,
  recoverAuthV2GoogleSignUp,
  resolveAuthV2SignUpTransferState,
  startAuthV2GoogleSignUp,
} from "./sign-up-external-strategies.ts";

const context = testContext();

function clerk(): Clerk {
  return mockedClerk as unknown as Clerk;
}

function signUpResource(): SignUpResource {
  return mockedClerk.client.signUp as unknown as SignUpResource;
}

beforeEach(() => {
  clearMockedAuthOnAbort(context.signal);
});

describe("Auth v2 sign-up external strategy handoff", () => {
  it("discovers Google from the current Clerk environment and resource", () => {
    mockAuthV2Capabilities({ googleOAuth: false });
    expect(
      discoverAuthV2SignUpExternalCapabilities(clerk(), signUpResource()),
    ).toStrictEqual({ googleOAuth: false });

    mockAuthV2Capabilities({ googleOAuth: true });
    expect(
      discoverAuthV2SignUpExternalCapabilities(clerk(), signUpResource()),
    ).toStrictEqual({ googleOAuth: true });
    expect(
      discoverAuthV2SignUpExternalCapabilities(
        clerk(),
        {} as unknown as SignUpResource,
      ),
    ).toStrictEqual({ googleOAuth: false });
  });

  it("hands Google sign-up to Clerk with the dedicated callback and attributed completion", async () => {
    context.mocks.browser.url(
      "https://app.vm0.ai/v2/sign-up?gclid=click-123&utm_campaign=summer#/start?step=oauth",
    );
    const { navigation } = resolveAuthV2PlatformContext("sign-up");

    await startAuthV2GoogleSignUp(signUpResource(), navigation, false);

    expect(mockedClerk.signUpAuthenticateWithRedirect).toHaveBeenCalledTimes(1);
    const params =
      mockedClerk.signUpAuthenticateWithRedirect.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      continueSignIn: false,
      continueSignUp: false,
      redirectUrlComplete: navigation.completionRedirectUrl,
      strategy: "oauth_google",
    });
    expect(params).not.toHaveProperty("legalAccepted");
    const callbackUrl = new URL(params?.redirectUrl ?? "", location.origin);
    expect(callbackUrl.pathname).toBe("/v2/sign-up/sso-callback");
    expect(callbackUrl.searchParams.get("gclid")).toBe("click-123");
    expect(callbackUrl.searchParams.get("utm_campaign")).toBe("summer");
    expect(callbackUrl.hash).toBe("#/start?step=oauth");
    const completionUrl = new URL(params?.redirectUrlComplete ?? "");
    expect(completionUrl.pathname).toBe("/onboarding");
    expect(completionUrl.searchParams.get("gclid")).toBe("click-123");
    expect(completionUrl.searchParams.get("utm_campaign")).toBe("summer");
  });
});

describe("Auth v2 sign-up external strategy transfer", () => {
  it("maps transferred sign-in states without activating or navigating", () => {
    expect(
      resolveAuthV2SignUpTransferState({
        createdSessionId: "session_transfer",
        status: "complete",
      }),
    ).toStrictEqual({
      sessionId: "session_transfer",
      status: "complete",
    });
    expect(
      resolveAuthV2SignUpTransferState({
        createdSessionId: null,
        status: "needs_first_factor",
      }),
    ).toStrictEqual({ status: "sign-in", stepPath: "/factor-one" });
    expect(
      resolveAuthV2SignUpTransferState({
        createdSessionId: null,
        status: "needs_second_factor",
      }),
    ).toStrictEqual({ status: "sign-in", stepPath: "/factor-two" });
    expect(
      resolveAuthV2SignUpTransferState({
        createdSessionId: null,
        status: "needs_new_password",
      }),
    ).toStrictEqual({ status: "sign-in", stepPath: "/reset-password" });
  });

  it("reloads a completed Google sign-up without taking activation ownership", async () => {
    mockSignUpResource({
      createdSessionId: "session_google_sign_up",
      externalAccountStatus: "verified",
      status: "complete",
    });

    const recovery = await recoverAuthV2GoogleSignUp(clerk());

    expect(recovery.status).toBe("sign-up");
    expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(1);
    expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
    expect(mockedClerk.handleRedirectCallback).not.toHaveBeenCalled();
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
  });

  it("transfers an existing identity once and reuses its state after callback reload", async () => {
    mockSignUpResource({
      externalAccountError: {
        code: "external_account_exists",
        message: "Account already exists",
      },
      externalAccountStatus: "transferable",
      isTransferable: true,
      status: "missing_requirements",
    });
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        createdSessionId: "session_existing_identity",
        status: "complete",
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });

    await expect(recoverAuthV2GoogleSignUp(clerk())).resolves.toMatchObject({
      sessionId: "session_existing_identity",
      status: "complete",
    });
    await expect(recoverAuthV2GoogleSignUp(clerk())).resolves.toMatchObject({
      sessionId: "session_existing_identity",
      status: "complete",
    });

    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(1);
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      transfer: true,
    });
    expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(2);
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
  });
});

describe("Auth v2 sign-up external strategy recovery", () => {
  it("returns incomplete transfer and callback error states to the flow", async () => {
    mockSignUpResource({
      externalAccountError: {
        code: "external_account_exists",
        message: "Account already exists",
      },
      externalAccountStatus: "transferable",
      isTransferable: true,
      status: "missing_requirements",
    });
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });

    await expect(recoverAuthV2GoogleSignUp(clerk())).resolves.toMatchObject({
      status: "sign-in",
      stepPath: "/factor-one",
    });

    mockSignInResource({ status: "needs_identifier" });
    mockSignUpResource({
      externalAccountError: {
        code: "oauth_callback_error",
        longMessage: "Google sign-up was cancelled.",
        message: "OAuth callback failed",
      },
      externalAccountStatus: "failed",
      status: null,
    });
    await expect(recoverAuthV2GoogleSignUp(clerk())).resolves.toMatchObject({
      error: { code: "oauth_callback_error" },
      status: "error",
    });
  });
});
