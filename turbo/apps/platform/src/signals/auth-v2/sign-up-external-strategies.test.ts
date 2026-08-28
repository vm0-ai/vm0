import type { PlatformClerk as Clerk } from "../../lib/clerk-runtime.ts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearMockedAuthOnAbort,
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
} from "../../__tests__/mock-auth.ts";
import { testContext } from "../__tests__/test-helpers.ts";
import {
  recoverAuthV2OAuthSignUp,
  resolveAuthV2SignUpTransferState,
} from "./sign-up-external-strategies.ts";

const context = testContext();

function clerk(): Clerk {
  return mockedClerk as unknown as Clerk;
}

beforeEach(() => {
  clearMockedAuthOnAbort(context.signal);
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

    const recovery = await recoverAuthV2OAuthSignUp(clerk());

    expect(recovery.status).toBe("sign-up");
    expect(mockedClerk.signUpReload).toHaveBeenCalledTimes(1);
    expect(mockedClerk.clientSignInCreate).not.toHaveBeenCalled();
    expect(mockedClerk.handleRedirectCallback).not.toHaveBeenCalled();
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
  });

  it("transfers an existing identity once and reuses its state after callback reload", async () => {
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
    mockedClerk.clientSignInCreate.mockImplementation(() => {
      mockSignInResource({
        createdSessionId: "session_existing_identity",
        identifier: "person@example.com",
        status: "complete",
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });

    await expect(recoverAuthV2OAuthSignUp(clerk())).resolves.toMatchObject({
      sessionId: "session_existing_identity",
      status: "complete",
    });
    await expect(recoverAuthV2OAuthSignUp(clerk())).resolves.toMatchObject({
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
      emailAddress: "person@example.com",
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
        identifier: "person@example.com",
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
      });
      return Promise.resolve(mockedClerk.client.signIn);
    });

    await expect(recoverAuthV2OAuthSignUp(clerk())).resolves.toMatchObject({
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
    await expect(recoverAuthV2OAuthSignUp(clerk())).resolves.toMatchObject({
      error: { code: "oauth_callback_error" },
      status: "error",
    });
  });
});
