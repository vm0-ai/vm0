import { describe, it, expect, vi, beforeEach } from "vitest";
import { reloadEnv } from "../../../env";
import { invokeCron } from "../cron";
import {
  simulateGitHubInstallation,
  simulateGitHubIssueOpened,
} from "../github";

describe("webhook-simulators", () => {
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
