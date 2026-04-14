import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpResponse } from "msw";
import type { StripeMockFns } from "../../../../__tests__/stripe-mock";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { http } from "../../../../__tests__/msw";
import { server } from "../../../../mocks/server";
import { reloadEnv } from "../../../../env";
import {
  updateOrgStripeSubscription,
  createTelegramInstallationForCompose,
  createSlackInstallationForOrg,
  findTestSlackOrgInstallation,
} from "../../../../__tests__/api-test-helpers";
import { updateAgentComposeOrg } from "../../../../__tests__/db-test-seeders/agents";
import { cleanupOrgExternalServices } from "../org-external-cleanup";

// --- Stripe mock (external dependency — allowed) ---

const stripeMocks = vi.hoisted<
  Pick<
    StripeMockFns,
    "subscriptionsRetrieve" | "subscriptionsUpdate" | "subscriptionsCancel"
  >
>(() => {
  return {
    subscriptionsRetrieve: vi.fn(),
    subscriptionsUpdate: vi.fn(),
    subscriptionsCancel: vi.fn(),
  };
});

vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          retrieve: stripeMocks.subscriptionsRetrieve,
          cancel: stripeMocks.subscriptionsCancel,
        },
      };
    },
  };
});

// --- Test setup ---

const context = testContext();

describe("cleanupOrgExternalServices", () => {
  beforeEach(() => {
    context.setupMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
    stripeMocks.subscriptionsCancel.mockResolvedValue({ id: "sub_cancelled" });
  });

  it("completes without error when org has no external services", async () => {
    const { orgId } = await context.setupUser();

    await cleanupOrgExternalServices(orgId);

    expect(stripeMocks.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("cancels active stripe subscription", async () => {
    const { orgId } = await context.setupUser();
    const subId = uniqueId("sub");
    await updateOrgStripeSubscription(orgId, subId, "active");

    await cleanupOrgExternalServices(orgId);

    expect(stripeMocks.subscriptionsCancel).toHaveBeenCalledWith(subId);
  });

  it("skips stripe cancellation when subscription is already canceled", async () => {
    const { orgId } = await context.setupUser();
    await updateOrgStripeSubscription(orgId, uniqueId("sub"), "canceled");

    await cleanupOrgExternalServices(orgId);

    expect(stripeMocks.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("skips stripe cancellation when no subscription exists", async () => {
    const { orgId } = await context.setupUser();

    await cleanupOrgExternalServices(orgId);

    expect(stripeMocks.subscriptionsCancel).not.toHaveBeenCalled();
  });

  it("deregisters telegram webhook for org installation", async () => {
    const { userId, orgId } = await context.setupUser();
    const compose = await context.createAgentCompose(userId);
    await updateAgentComposeOrg(compose.id, orgId);

    const botToken = "test-bot-token-123";
    await createTelegramInstallationForCompose(compose.id, userId, botToken);

    const telegramHandler = http.post(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(telegramHandler.handler);

    await cleanupOrgExternalServices(orgId);

    expect(telegramHandler.mocked).toHaveBeenCalledTimes(1);
  });

  it("deregisters multiple telegram webhooks", async () => {
    const { userId, orgId } = await context.setupUser();

    const compose1 = await context.createAgentCompose(userId, {
      name: uniqueId("compose"),
    });
    const compose2 = await context.createAgentCompose(userId, {
      name: uniqueId("compose"),
    });
    await updateAgentComposeOrg(compose1.id, orgId);
    await updateAgentComposeOrg(compose2.id, orgId);

    const token1 = "bot-token-one";
    const token2 = "bot-token-two";
    await createTelegramInstallationForCompose(compose1.id, userId, token1);
    await createTelegramInstallationForCompose(compose2.id, userId, token2);

    const handler1 = http.post(
      `https://api.telegram.org/bot${token1}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    const handler2 = http.post(
      `https://api.telegram.org/bot${token2}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(handler1.handler, handler2.handler);

    await cleanupOrgExternalServices(orgId);

    expect(handler1.mocked).toHaveBeenCalledTimes(1);
    expect(handler2.mocked).toHaveBeenCalledTimes(1);
  });

  it("revokes connector tokens for org connectors", async () => {
    const { userId, orgId } = await context.setupUser();
    // revokeConnectorToken will skip gracefully since OAuth credentials
    // are not configured in the test environment — best-effort by design
    await context.createConnector(orgId, { userId, type: "github" });

    // Should complete without error even with no OAuth creds configured
    await cleanupOrgExternalServices(orgId);
  });

  it("cleans up slack workspace installation", async () => {
    const { orgId } = await context.setupUser();
    const workspaceId = uniqueId("W");
    await createSlackInstallationForOrg(orgId, workspaceId);

    await cleanupOrgExternalServices(orgId);

    // Verify installation was cleaned up
    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeUndefined();
  });

  it("continues cleanup when stripe cancellation fails", async () => {
    const { userId, orgId } = await context.setupUser();
    const subId = uniqueId("sub");
    await updateOrgStripeSubscription(orgId, subId, "active");
    await context.createConnector(orgId, { userId, type: "github" });

    stripeMocks.subscriptionsCancel.mockRejectedValue(
      new Error("Stripe API down"),
    );

    // Should not throw — all operations are best-effort
    await cleanupOrgExternalServices(orgId);

    expect(stripeMocks.subscriptionsCancel).toHaveBeenCalledWith(subId);
  });

  it("continues deregistering other webhooks when one telegram installation fails", async () => {
    const { userId, orgId } = await context.setupUser();

    const compose1 = await context.createAgentCompose(userId, {
      name: uniqueId("compose"),
    });
    const compose2 = await context.createAgentCompose(userId, {
      name: uniqueId("compose"),
    });
    await updateAgentComposeOrg(compose1.id, orgId);
    await updateAgentComposeOrg(compose2.id, orgId);

    const tokenFail = "token-fail";
    const tokenOk = "token-ok";
    await createTelegramInstallationForCompose(compose1.id, userId, tokenFail);
    await createTelegramInstallationForCompose(compose2.id, userId, tokenOk);

    const failHandler = http.post(
      `https://api.telegram.org/bot${tokenFail}/deleteWebhook`,
      () => {
        return HttpResponse.error();
      },
    );
    const okHandler = http.post(
      `https://api.telegram.org/bot${tokenOk}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(failHandler.handler, okHandler.handler);

    await cleanupOrgExternalServices(orgId);

    // Both were attempted despite the first one failing
    expect(failHandler.mocked).toHaveBeenCalledTimes(1);
    expect(okHandler.mocked).toHaveBeenCalledTimes(1);
  });

  it("is idempotent - calling twice produces no errors", async () => {
    const { orgId } = await context.setupUser();
    const subId = uniqueId("sub");
    await updateOrgStripeSubscription(orgId, subId, "active");

    await cleanupOrgExternalServices(orgId);
    await cleanupOrgExternalServices(orgId);

    // Stripe cancel called twice (once per invocation, since we don't
    // update subscriptionStatus locally — Stripe webhook would do that)
    expect(stripeMocks.subscriptionsCancel).toHaveBeenCalledTimes(2);
  });
});
