import assert from "node:assert/strict";
import { test } from "node:test";

import { errors } from "@playwright/test";

import {
  captureClerkReadiness,
  describeClerkReadiness,
  waitForClerkReadiness,
  type ClerkReadinessPage,
  type ClerkReadinessState,
} from "./clerk-readiness";

const BOOTSTRAPPING_APP: ClerkReadinessState = {
  bootstrapSkeleton: "active",
  client: "absent",
  organizationId: null,
  readyState: "complete",
  route: "https://staging-app.omby.ai/",
  sessionPresent: false,
};

const SIGNED_OUT_CLIENT: ClerkReadinessState = {
  bootstrapSkeleton: "removed",
  client: "loaded",
  organizationId: null,
  readyState: "complete",
  route: "https://staging-app.omby.ai/",
  sessionPresent: false,
};

function stubPage(state: ClerkReadinessState): ClerkReadinessPage {
  return {
    evaluate: () => Promise.resolve(state),
  };
}

function failingPage(reason: string): ClerkReadinessPage {
  return {
    evaluate: () => Promise.reject(new Error(reason)),
  };
}

test("a stalled Clerk bootstrap is described by its observed state", async (context) => {
  await context.test("an absent client is separated from a loaded one", () => {
    const stalled = describeClerkReadiness({
      kind: "observed",
      state: BOOTSTRAPPING_APP,
    });
    assert.match(stalled, /client=absent/u);
    assert.match(stalled, /bootstrapSkeleton=active/u);

    const signedOut = describeClerkReadiness({
      kind: "observed",
      state: SIGNED_OUT_CLIENT,
    });
    assert.match(signedOut, /client=loaded/u);
    assert.match(signedOut, /session=absent/u);
    assert.match(signedOut, /bootstrapSkeleton=removed/u);
  });

  await context.test("an unreadable page reports why", () => {
    const report = describeClerkReadiness({
      kind: "unavailable",
      reason: "Target page, context or browser has been closed",
    });
    assert.match(report, /unavailable \(Target page/u);
  });
});

test("readiness capture never replaces the failure it explains", async (context) => {
  await context.test(
    "an evaluate failure becomes an unavailable report",
    async () => {
      const report = await captureClerkReadiness(failingPage("page closed"));
      assert.deepEqual(report, { kind: "unavailable", reason: "page closed" });
    },
  );

  await context.test(
    "a timeout carries the state and the original error",
    async () => {
      const timeout = new errors.TimeoutError(
        "page.waitForFunction: Timeout 30000ms exceeded.",
      );
      const failure = await waitForClerkReadiness(
        stubPage(BOOTSTRAPPING_APP),
        "the Clerk client to load",
        () => Promise.reject(timeout),
      ).then(
        () => null,
        (error: unknown) => error,
      );

      assert.ok(failure instanceof Error);
      assert.match(failure.message, /Timed out waiting for the Clerk client/u);
      assert.match(failure.message, /client=absent/u);
      assert.equal(failure.cause, timeout);
    },
  );

  await context.test(
    "a non-timeout failure is rethrown untouched",
    async () => {
      const original = new Error(
        "Clerk session token unavailable after refresh",
      );
      const failure = await waitForClerkReadiness(
        stubPage(SIGNED_OUT_CLIENT),
        "a Clerk session",
        () => Promise.reject(original),
      ).then(
        () => null,
        (error: unknown) => error,
      );

      assert.equal(failure, original);
    },
  );
});
