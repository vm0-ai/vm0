import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { GET, PATCH, DELETE } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  createTestTelegramInstallation,
} from "../../../../../src/__tests__/api-test-helpers";
import { server } from "../../../../../src/mocks/server";
import { http } from "../../../../../src/__tests__/msw";

const context = testContext();

function telegramDeleteWebhook() {
  return http.post(/api\.telegram\.org\/bot.*\/deleteWebhook/, () =>
    HttpResponse.json({ ok: true, result: true }),
  );
}

describe("/api/integrations/telegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 404 when user has no Telegram link", async () => {
      await context.setupUser();

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("returns bot info for linked admin user", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
      );
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.bot.id).toBeDefined();
      expect(data.bot.username).toBeDefined();
      expect(data.agent).toBeDefined();
      expect(data.isAdmin).toBe(true);
      expect(data.environment).toBeDefined();
    });
  });

  describe("PATCH", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "my-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 for non-admin user", async () => {
      const user = await context.setupUser();
      // Create installation where admin is a different user
      await createTestTelegramInstallation({
        adminUserId: "other-admin",
        vm0UserId: user.userId,
      });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: "my-agent" }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("updates default agent for admin", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      // Create a new agent to switch to
      const newAgentName = uniqueId("new-agent");
      await createTestCompose(newAgentName);

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentName: newAgentName }),
        },
      );
      const response = await PATCH(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.ok).toBe(true);
    });
  });

  describe("DELETE", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 403 for non-admin user", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: "other-admin",
        vm0UserId: user.userId,
      });

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("deletes installation and removes webhook for admin", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      const deleteHandler = telegramDeleteWebhook();
      server.use(deleteHandler.handler);

      const request = new Request(
        "http://localhost:3000/api/integrations/telegram",
        { method: "DELETE" },
      );
      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteHandler.mocked).toHaveBeenCalledTimes(1);

      // Verify user is no longer linked
      const getRequest = new Request(
        "http://localhost:3000/api/integrations/telegram",
      );
      const getResponse = await GET(getRequest);
      expect(getResponse.status).toBe(404);
    });
  });
});
