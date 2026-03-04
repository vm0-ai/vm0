import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import { verifyLinkToken } from "../../../../../../src/lib/telegram/handlers/start";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createTestTelegramInstallation } from "../../../../../../src/__tests__/api-test-helpers";

const context = testContext();

function linkRequest(method: string, body?: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/integrations/telegram/link", {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}

describe("/api/integrations/telegram/link", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  describe("GET", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns linked: false when user has no link", async () => {
      await context.setupUser();

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(false);
    });

    it("returns linked: true with telegramUserId when linked", async () => {
      const user = await context.setupUser();
      await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      const response = await GET(linkRequest("GET"));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.linked).toBe(true);
      expect(data.telegramUserId).toBeDefined();
    });
  });

  describe("POST", () => {
    it("returns 401 when not authenticated", async () => {
      mockClerk({ userId: null });

      const response = await POST(
        linkRequest("POST", { installationId: "some-id" }),
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("returns 400 when installationId is missing", async () => {
      await context.setupUser();

      const response = await POST(linkRequest("POST", {}));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error.code).toBe("BAD_REQUEST");
    });

    it("returns 404 when installation does not exist", async () => {
      await context.setupUser();

      const response = await POST(
        linkRequest("POST", {
          installationId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("generates a valid deep link token", async () => {
      const user = await context.setupUser();
      const installationId = await createTestTelegramInstallation({
        adminUserId: user.userId,
        vm0UserId: user.userId,
      });

      const response = await POST(linkRequest("POST", { installationId }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.token).toBeDefined();
      expect(data.deepLink).toContain("https://t.me/");
      expect(data.deepLink).toContain(`?start=${data.token}`);

      // Verify the token is valid using the exported verifier
      const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
      const payload = verifyLinkToken(data.token, SECRETS_ENCRYPTION_KEY);
      expect(payload).toEqual(
        expect.objectContaining({
          vm0UserId: user.userId,
          installationId,
        }),
      );
    });
  });
});
