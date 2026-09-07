import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function withClerkSatelliteSync(url: string): string {
  const destination = new URL(url);
  destination.searchParams.set("__clerk_synced", "false");
  return destination.toString();
}

function clerkAuthFragment(url: URL): URL {
  if (!url.hash.startsWith("#/")) {
    throw new Error("Expected Clerk auth state in the URL fragment");
  }
  return new URL(url.hash.slice(1), url.origin);
}

test("A satellite v1 sign-in keeps the comparison route on the primary app", async () => {
  const returnUrl = "https://app.okou.ai/agents?source=v1-sign-in";

  await startPage({
    context,
    host: "app.okou.ai",
    path: `/v1/sign-in?redirect_url=${encodeURIComponent(returnUrl)}`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/v1/sign-in");
  expect(clerkAuthFragment(destination).searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
  expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
});

test("A nested satellite v1 sign-up keeps its Clerk task path", async () => {
  const returnUrl = "https://app.okou.ai/onboarding?source=v1-task";

  await startPage({
    context,
    host: "app.okou.ai",
    path: `/v1/sign-up/tasks/choose-organization?session_id=session-test&redirect_url=${encodeURIComponent(
      returnUrl,
    )}#/tasks/choose-organization?attempt=1`,
    auth: null,
  });

  await waitFor(() => {
    expect(location.origin).toBe("https://app.vm0.ai");
  });
  const destination = new URL(location.href);
  expect(destination.pathname).toBe("/v1/sign-up/tasks/choose-organization");
  expect(destination.searchParams.get("session_id")).toBe("session-test");
  const authFragment = clerkAuthFragment(destination);
  expect(authFragment.pathname).toBe("/tasks/choose-organization");
  expect(authFragment.searchParams.get("attempt")).toBe("1");
  expect(authFragment.searchParams.get("redirect_url")).toBe(
    withClerkSatelliteSync(returnUrl),
  );
});
