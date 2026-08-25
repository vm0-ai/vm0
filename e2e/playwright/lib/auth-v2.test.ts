import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Response, Route } from "@playwright/test";

import {
  AuthV2TestResources,
  type AuthV2ResourceAdapter,
  cacheAuthV2VerificationPreparations,
  classifyAuthV2VerificationRequest,
} from "./auth-v2";

test("classifies only Clerk Auth v2 verification requests", () => {
  assert.deepEqual(
    classifyAuthV2VerificationRequest(
      "https://clerk.example.test/v1/client/sign_ins/attempt_123/prepare_first_factor?__clerk_testing_token=masked",
      "clerk.example.test",
    ),
    { action: "prepare", flow: "sign-in" },
  );
  assert.deepEqual(
    classifyAuthV2VerificationRequest(
      "https://clerk.example.test/v1/client/sign_ups/attempt_456/attempt_verification",
      "https://clerk.example.test",
    ),
    { action: "attempt", flow: "sign-up" },
  );
  assert.equal(
    classifyAuthV2VerificationRequest(
      "https://other.example.test/v1/client/sign_ins/id/attempt_verification",
      "clerk.example.test",
    ),
    null,
  );
  assert.equal(
    classifyAuthV2VerificationRequest(
      "https://clerk.example.test/v1/client/sign_ins/id/create",
      "clerk.example.test",
    ),
    null,
  );
  assert.equal(
    classifyAuthV2VerificationRequest(
      "https://clerk.example.test/v1/client/sign_ins/id/prepare_verification",
      "clerk.example.test",
    ),
    null,
  );
  assert.equal(
    classifyAuthV2VerificationRequest(
      "https://clerk.example.test/v1/client/sign_ups/id/attempt_first_factor",
      "clerk.example.test",
    ),
    null,
  );
  assert.equal(
    classifyAuthV2VerificationRequest("not a url", "clerk.example.test"),
    null,
  );
});

test("tracks exact resources and cleans organizations before users", async () => {
  const events: string[] = [];
  let emailSequence = 0;
  const adapter: AuthV2ResourceAdapter = {
    createOrganization: async (name, userId) => {
      events.push(`create-org:${name}:${userId}`);
      return `org-${name}`;
    },
    createPasswordUser: async (email, password) => {
      assert.equal(password.length >= 28, true);
      assert.equal(/[a-z]/.test(password), true);
      assert.equal(/[A-Z]/.test(password), true);
      assert.equal(/[0-9]/.test(password), true);
      assert.equal(/[^a-zA-Z0-9]/.test(password), true);
      events.push(`create-user:${email}`);
      return "user-auth-v2";
    },
    deleteOrganization: async (organizationId) => {
      events.push(`delete-org:${organizationId}`);
    },
    deleteUser: async (email) => {
      events.push(`delete-user:${email}`);
    },
    generateEmail: () => {
      emailSequence += 1;
      return `test-${emailSequence}@example.test`;
    },
  };
  const resources = new AuthV2TestResources(adapter);

  await resources.createPasswordIdentity(["alpha", "beta"]);
  resources.allocateEmail();
  await resources.cleanup();

  assert.deepEqual(events, [
    "create-user:test-1@example.test",
    "create-org:alpha:user-auth-v2",
    "create-org:beta:user-auth-v2",
    "delete-org:org-beta",
    "delete-org:org-alpha",
    "delete-user:test-2@example.test",
    "delete-user:test-1@example.test",
  ]);
});

test("replays preparation responses only for the same Clerk resource", async () => {
  const previousFrontendApi = process.env.CLERK_FAPI;
  process.env.CLERK_FAPI = "clerk.example.test";
  let responseHandler: ((response: Response) => Promise<void>) | undefined;
  let routeHandler: ((route: Route) => Promise<void>) | undefined;
  let removedResponseHandler = false;
  let removedRouteHandler = false;
  const page = {
    off: (
      event: string,
      handler: (response: Response) => Promise<void>,
    ): void => {
      removedResponseHandler =
        event === "response" && handler === responseHandler;
    },
    on: (
      event: string,
      handler: (response: Response) => Promise<void>,
    ): void => {
      assert.equal(event, "response");
      responseHandler = handler;
    },
    route: async (
      _pattern: string,
      handler: (route: Route) => Promise<void>,
    ): Promise<void> => {
      routeHandler = handler;
    },
    unroute: async (
      _pattern: string,
      handler: (route: Route) => Promise<void>,
    ): Promise<void> => {
      removedRouteHandler = handler === routeHandler;
    },
  } as unknown as Page;

  try {
    const cache = await cacheAuthV2VerificationPreparations(page, "sign-in");
    assert.ok(responseHandler);
    assert.ok(routeHandler);
    const resourceUrl =
      "https://clerk.example.test/v1/client/sign_ins/attempt_alpha/prepare_first_factor";
    await responseHandler({
      body: async () => Buffer.from('{"status":"ok"}'),
      headers: () => ({
        "content-length": "15",
        "content-type": "application/json",
      }),
      ok: () => true,
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      url: () => resourceUrl,
    } as unknown as Response);
    assert.equal(cache.cachedResourceCount(), 1);

    let replay: Record<string, unknown> | undefined;
    let fallbacks = 0;
    await routeHandler({
      fallback: async () => {
        fallbacks += 1;
      },
      fulfill: async (options: Parameters<Route["fulfill"]>[0]) => {
        replay = options as Record<string, unknown>;
      },
      request: () => ({ method: () => "POST", url: () => resourceUrl }),
    } as unknown as Route);
    assert.equal(fallbacks, 0);
    assert.equal(replay?.status, 200);
    assert.deepEqual(replay?.headers, { "content-type": "application/json" });

    await routeHandler({
      fallback: async () => {
        fallbacks += 1;
      },
      fulfill: async () => {
        throw new Error("a different resource must not be replayed");
      },
      request: () => ({
        method: () => "POST",
        url: () => resourceUrl.replace("attempt_alpha", "attempt_beta"),
      }),
    } as unknown as Route);
    assert.equal(fallbacks, 1);

    await cache.dispose();
    assert.equal(removedResponseHandler, true);
    assert.equal(removedRouteHandler, true);
    assert.equal(cache.cachedResourceCount(), 0);
  } finally {
    if (previousFrontendApi === undefined) {
      delete process.env.CLERK_FAPI;
    } else {
      process.env.CLERK_FAPI = previousFrontendApi;
    }
  }
});

test("cleanup continues after failures and reports no resource identifiers", async () => {
  let deleteAttempts = 0;
  const resources = new AuthV2TestResources({
    createOrganization: async () => "sensitive-organization-id",
    createPasswordUser: async () => "sensitive-user-id",
    deleteOrganization: async () => {
      deleteAttempts += 1;
      throw new Error("provider failure for sensitive-organization-id");
    },
    deleteUser: async () => {
      deleteAttempts += 1;
      throw new Error("provider failure for sensitive-email@example.test");
    },
    generateEmail: () => "sensitive-email@example.test",
  });
  await resources.createPasswordIdentity(["organization"]);

  await assert.rejects(resources.cleanup(), (error: unknown) => {
    assert.equal(error instanceof AggregateError, true);
    if (!(error instanceof AggregateError)) {
      return false;
    }
    const rendered = `${error.message} ${error.errors
      .map((candidate) => String(candidate))
      .join(" ")}`;
    assert.equal(rendered.includes("sensitive"), false);
    return true;
  });
  assert.equal(deleteAttempts, 2);

  await resources.cleanup();
  assert.equal(deleteAttempts, 2);
});
