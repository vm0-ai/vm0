import { describe, it, expect, beforeEach } from "vitest";
import { http as mswHttp, HttpResponse } from "msw";
import { GET, PATCH, DELETE } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  createTestOrg,
  createTestOrgTelegramInstallation,
  findTestOrgTelegramInstallation,
  findTestTelegramUserLink,
} from "../../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

function telegramOAuthProbe(domainConfigured: boolean) {
  return mswHttp.head(/oauth\.telegram\.org\/auth/, () =>
    HttpResponse.text("", {
      headers: { "content-length": domainConfigured ? "5000" : "100" },
    }),
  );
}

function telegramDeleteWebhook() {
  return mswHttp.post(/api\.telegram\.org\/bot.*\/deleteWebhook/, () =>
    HttpResponse.json({ ok: true, result: true }),
  );
}

async function givenOrgTelegramSetup(
  options: {
    isAdmin?: boolean;
    withConnection?: boolean;
    enabled?: boolean;
  } = {},
) {
  const { isAdmin = false, withConnection = true, enabled = true } = options;
  const user = await context.setupUser();
  const org = await createTestOrg(uniqueId("org"));

  const { installationId, telegramBotId } =
    await createTestOrgTelegramInstallation({
      orgId: org.id,
      adminUserId: user.userId,
      vm0UserId: withConnection ? user.userId : undefined,
      enabled,
    });

  mockClerk({
    userId: user.userId,
    orgId: org.id,
    orgRole: isAdmin ? "org:admin" : "org:member",
  });

  server.use(telegramOAuthProbe(true));

  return { user, org, installationId, telegramBotId };
}

describe("/api/zero/integrations/telegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns isInstalled=false when no bot is installed for the org", async () => {
      await context.setupUser();
      await createTestOrg(uniqueId("org"));

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isInstalled).toBe(false);
      expect(data.isConnected).toBe(false);
    });

    it("returns isConnected=false when user has no connection", async () => {
      await givenOrgTelegramSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isInstalled).toBe(true);
      expect(data.isConnected).toBe(false);
    });

    it("returns connected status with bot info", async () => {
      const { telegramBotId } = await givenOrgTelegramSetup({
        withConnection: true,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isConnected).toBe(true);
      expect(data.isInstalled).toBe(true);
      expect(data.bot.id).toBe(telegramBotId);
    });

    it("returns isAdmin=true for admin members", async () => {
      await givenOrgTelegramSetup({ isAdmin: true });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(true);
    });

    it("returns isAdmin=false for non-admin members", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.isAdmin).toBe(false);
    });

    it("returns enabled status", async () => {
      await givenOrgTelegramSetup({ enabled: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.enabled).toBe(false);
    });

    it("returns environment info when connected", async () => {
      await givenOrgTelegramSetup();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.environment).toBeDefined();
      expect(data.environment.requiredSecrets).toBeDefined();
      expect(data.environment.missingSecrets).toBeDefined();
    });
  });

  describe("PATCH", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 when non-admin tries to toggle", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("toggles enabled state for admin", async () => {
      const { org } = await givenOrgTelegramSetup({
        isAdmin: true,
        enabled: true,
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify in DB
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation?.enabled).toBe(false);
    });

    it("returns 404 when no installation exists", async () => {
      await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: (await context.setupUser()).userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });
  });

  describe("DELETE (disconnect)", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no connection", async () => {
      await givenOrgTelegramSetup({ withConnection: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes user link and returns ok", async () => {
      const { user, installationId } = await givenOrgTelegramSetup();

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify link was deleted
      const link = await findTestTelegramUserLink(user.userId, installationId);
      expect(link).toBeUndefined();
    });
  });

  describe("DELETE ?action=uninstall", () => {
    it("returns 403 when non-admin tries to uninstall", async () => {
      await givenOrgTelegramSetup({ isAdmin: false });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 when no installation exists", async () => {
      const user = await context.setupUser();
      const org = await createTestOrg(uniqueId("org"));
      mockClerk({
        userId: user.userId,
        orgId: org.id,
        orgRole: "org:admin",
      });

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("deletes installation and returns ok", async () => {
      const { org } = await givenOrgTelegramSetup({ isAdmin: true });
      server.use(telegramDeleteWebhook());

      const request = new Request(
        "http://localhost:3000/api/zero/integrations/telegram?action=uninstall",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify installation was deleted
      const installation = await findTestOrgTelegramInstallation(org.id);
      expect(installation).toBeUndefined();
    });
  });
});
