import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCliToken,
  seedTestSkill,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

const context = testContext();
let testCliToken: string;
let testId: string;

function resolveRequest(body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return createTestRequest("http://localhost:3000/api/skills/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/skills/resolve", () => {
  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    testId = Math.random().toString(36).substring(7);
  });

  describe("Authentication", () => {
    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });
      const response = await POST(
        resolveRequest({
          skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
        }),
      );
      expect(response.status).toBe(401);
    });

    it("should accept CLI token authentication", async () => {
      mockClerk({ userId: null });
      const response = await POST(
        resolveRequest(
          {
            skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/slack"],
          },
          testCliToken,
        ),
      );
      expect(response.status).toBe(200);
    });
  });

  describe("Validation", () => {
    it("should reject empty skills array", async () => {
      const response = await POST(resolveRequest({ skills: [] }, testCliToken));
      expect(response.status).toBe(400);
    });

    it("should reject invalid URLs", async () => {
      const response = await POST(
        resolveRequest({ skills: ["not-a-url"] }, testCliToken),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("Resolution", () => {
    it("should resolve seeded skills", async () => {
      const skillUrl = `https://github.com/vm0-ai/vm0-skills/tree/main/resolve-${testId}`;
      await seedTestSkill({
        url: skillUrl,
        name: `resolve-${testId}`,
        fullPath: `vm0-ai/vm0-skills/tree/main/resolve-${testId}`,
      });

      const response = await POST(
        resolveRequest({ skills: [skillUrl] }, testCliToken),
      );
      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.resolved[skillUrl]).toBeDefined();
      expect(data.resolved[skillUrl].storageName).toBe(
        `agent-skills@vm0-ai/vm0-skills/tree/main/resolve-${testId}`,
      );
      expect(data.resolved[skillUrl].versionHash).toBeDefined();
      expect(data.resolved[skillUrl].frontmatter.name).toBe("Slack");
      expect(data.resolved[skillUrl].frontmatter.vm0_secrets).toEqual([
        "SLACK_BOT_TOKEN",
      ]);
      expect(data.unresolved).toEqual([]);
    });

    it("should return unresolved for unknown skills", async () => {
      const unknownUrl = `https://github.com/acme/custom/tree/main/unknown-${testId}`;

      const response = await POST(
        resolveRequest({ skills: [unknownUrl] }, testCliToken),
      );
      const data = await response.json();

      expect(data.resolved).toEqual({});
      expect(data.unresolved).toEqual([unknownUrl]);
    });

    it("should handle mixed resolved and unresolved", async () => {
      const skillUrl = `https://github.com/vm0-ai/vm0-skills/tree/main/mixed-${testId}`;
      await seedTestSkill({
        url: skillUrl,
        name: `mixed-${testId}`,
        fullPath: `vm0-ai/vm0-skills/tree/main/mixed-${testId}`,
      });
      const unknownUrl = `https://github.com/acme/custom/tree/main/unknown-${testId}`;

      const response = await POST(
        resolveRequest({ skills: [skillUrl, unknownUrl] }, testCliToken),
      );
      const data = await response.json();

      expect(Object.keys(data.resolved)).toHaveLength(1);
      expect(data.resolved[skillUrl]).toBeDefined();
      expect(data.unresolved).toEqual([unknownUrl]);
    });

    it("should treat skills without versionHash as unresolved", async () => {
      const skillUrl = `https://github.com/vm0-ai/vm0-skills/tree/main/nohash-${testId}`;
      await seedTestSkill({
        url: skillUrl,
        name: `nohash-${testId}`,
        fullPath: `vm0-ai/vm0-skills/tree/main/nohash-${testId}`,
        versionHash: null,
      });

      const response = await POST(
        resolveRequest({ skills: [skillUrl] }, testCliToken),
      );
      const data = await response.json();

      expect(data.resolved).toEqual({});
      expect(data.unresolved).toEqual([skillUrl]);
    });

    it("should handle all skills unresolved when none match", async () => {
      const urls = [
        `https://github.com/vm0-ai/vm0-skills/tree/main/notfound1-${testId}`,
        `https://github.com/vm0-ai/vm0-skills/tree/main/notfound2-${testId}`,
      ];
      const response = await POST(
        resolveRequest({ skills: urls }, testCliToken),
      );
      const data = await response.json();

      expect(data.resolved).toEqual({});
      expect(data.unresolved).toEqual(urls);
    });
  });
});
