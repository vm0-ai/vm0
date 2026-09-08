import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  mockedClerk,
  mockSignInResource,
  mockSignUpResource,
} from "../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
const ticket = "private-invitation-ticket";
async function button(name: string) {
  return await waitFor(() => {
    const found = queryAllByRoleFast("button").find((element) => {
      return (
        element.textContent?.trim() === name ||
        element.getAttribute("aria-label") === name
      );
    });
    if (!found) {
      throw new Error(`Missing button: ${name}`);
    }
    return found;
  });
}

test("An invitation to the app root signs an existing user in and removes the ticket before analytics", async () => {
  const analytics = context.mocks.posthog();
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    mockSignInResource({
      status: "complete",
      createdSessionId: "session_invited",
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: `/agents?__clerk_status=sign_in&__clerk_ticket=${ticket}`,
    env: { VITE_POSTHOG_KEY: "phc_platform_test" },
  });
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.clientSignInCreate).toHaveBeenCalledExactlyOnceWith({
    strategy: "ticket",
    ticket,
  });
  expect(mockedClerk.setActive).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ session: "session_invited" }),
  );
  expect(location.pathname).toBe("/agents");
  expect(location.href).not.toContain(ticket);
  expect(JSON.stringify(analytics.events)).not.toContain(ticket);
});

test("An invitation sign-in continues through a required second factor", async () => {
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    mockSignInResource({
      status: "needs_second_factor",
      supportedSecondFactors: [{ strategy: "totp" }],
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  mockedClerk.signInAttemptSecondFactor.mockImplementation(() => {
    mockSignInResource({
      status: "complete",
      createdSessionId: "session_invited",
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: `/sign-in?__clerk_status=sign_in&__clerk_ticket=${ticket}`,
  });
  await fill(await screen.findByLabelText("Verification code"), "123456");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  click(await button("Continue"));
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.signInAttemptSecondFactor).toHaveBeenCalledExactlyOnceWith(
    { strategy: "totp", code: "123456" },
  );
});

test("A new invitee completes the remaining sign-up fields without creating another attempt or verifying email again", async () => {
  mockedClerk.clientSignUpCreate.mockImplementation(() => {
    mockSignUpResource({
      status: "missing_requirements",
      emailAddress: "invited@example.com",
      emailVerificationStatus: "verified",
      requiredFields: ["email_address", "password"],
      missingFields: ["password"],
      optionalFields: [],
      unverifiedFields: [],
    });
    return Promise.resolve(mockedClerk.client.signUp);
  });
  mockedClerk.signUpUpdate.mockImplementation(() => {
    mockSignUpResource({
      status: "complete",
      createdSessionId: "session_new_invitee",
      emailAddress: "invited@example.com",
    });
    return Promise.resolve(mockedClerk.client.signUp);
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: `/?__clerk_status=sign_up&__clerk_ticket=${ticket}`,
  });
  await fill(
    await screen.findByLabelText("Password"),
    "A strong new password 123!",
  );
  click(await button("Continue"));
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.clientSignUpCreate).toHaveBeenCalledExactlyOnceWith({
    strategy: "ticket",
    ticket,
  });
  expect(mockedClerk.signUpUpdate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ password: "A strong new password 123!" }),
  );
  expect(
    mockedClerk.signUpPrepareEmailAddressVerification,
  ).not.toHaveBeenCalled();
  expect(location.href).not.toContain(ticket);
});

test("A failed invitation exchange is safe to retry and coalesces repeated clicks", async () => {
  const exchange = createDeferredPromise<typeof mockedClerk.client.signIn>(
    context.signal,
  );
  mockedClerk.clientSignInCreate
    .mockRejectedValueOnce(
      new Error(`invalid ticket=${ticket} private@example.com`),
    )
    .mockReturnValueOnce(exchange.promise);
  await setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: `/?__clerk_status=sign_in&__clerk_ticket=${ticket}`,
  });
  await screen.findByRole("heading", { name: "Sign-in couldn't be completed" });
  expect(document.body).not.toHaveTextContent(ticket);
  expect(document.body).not.toHaveTextContent("private@example.com");
  expect(mockedClerk.setActive).not.toHaveBeenCalled();
  const retry = await button("Try again");
  click(retry);
  click(retry);
  await waitFor(() => {
    return expect(mockedClerk.clientSignInCreate).toHaveBeenCalledTimes(2);
  });
  await act(async () => {
    mockSignInResource({
      status: "complete",
      createdSessionId: "session_invited",
    });
    exchange.resolve(mockedClerk.client.signIn);
    await exchange.promise;
  });
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(mockedClerk.setActive).toHaveBeenCalledTimes(1);
});

test("Invitation exchange preserves the return URL in Clerk's auth fragment", async () => {
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    mockSignInResource({
      status: "complete",
      createdSessionId: "session_fragment",
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path: `/sign-in?__clerk_status=sign_in&__clerk_ticket=${ticket}#/?redirect_url=${encodeURIComponent("https://app.okou.ai/agents?__clerk_synced=false")}`,
  });
  await screen.findByRole("heading", { name: "Sign-in complete" });
  expect(location.origin).toBe("https://app.okou.ai");
  expect(location.pathname).toBe("/agents");
  expect(location.search).toBe("?__clerk_synced=false");
  expect(location.href).not.toContain(ticket);
});
