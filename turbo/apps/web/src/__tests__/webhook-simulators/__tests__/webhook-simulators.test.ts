import { describe, it, expect, vi, beforeEach } from "vitest";
import { reloadEnv } from "../../../env";
import {
  simulateClerkOrgCreated,
  simulateClerkOrgDeleted,
  simulateClerkUserDeleted,
} from "../clerk";
import { invokeCron } from "../cron";
import {
  simulateGitHubInstallation,
  simulateGitHubIssueOpened,
} from "../github";

// Clerk mock setup (must be at module level)
const mockVerifyWebhook = vi.hoisted(() => {
  return vi.fn();
});
vi.mock("@clerk/nextjs/webhooks", () => {
  return {
    verifyWebhook: mockVerifyWebhook,
  };
});

describe("webhook-simulators", () => {
  describe("clerk", () => {
    it("simulateClerkOrgCreated returns 200", async () => {
      const response = await simulateClerkOrgCreated(
        "org_test",
        "Test Org",
        "test-org",
      );
      expect(response.status).toBe(200);
      expect(mockVerifyWebhook).toHaveBeenCalled();
    });

    it("simulateClerkOrgDeleted returns 200", async () => {
      const response = await simulateClerkOrgDeleted("org_test");
      expect(response.status).toBe(200);
    });

    it("simulateClerkUserDeleted returns 200", async () => {
      const response = await simulateClerkUserDeleted("user_test");
      expect(response.status).toBe(200);
    });
  });

  describe("cron", () => {
    it("invokeCron passes auth header to handler", async () => {
      const handler = vi
        .fn()
        .mockResolvedValue(new Response("OK", { status: 200 }));
      const response = await invokeCron(handler);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();

      const request = handler.mock.calls[0]![0] as Request;
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toMatch(/^Bearer .+$/);
    });
  });

  describe("github", () => {
    beforeEach(() => {
      vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", "test-github-webhook-secret");
      vi.stubEnv("GITHUB_APP_SLUG", "vm0-bot");
      reloadEnv();
    });

    it("simulateGitHubInstallation produces valid signature", async () => {
      const response = await simulateGitHubInstallation(
        99999,
        55555,
        "created",
      );
      // If signature was invalid, we'd get 401
      expect(response.status).not.toBe(401);
    });

    it("simulateGitHubIssueOpened produces valid signature", async () => {
      const response = await simulateGitHubIssueOpened(99999, {
        number: 42,
        title: "Test Issue",
      });
      expect(response.status).not.toBe(401);
    });
  });
});
