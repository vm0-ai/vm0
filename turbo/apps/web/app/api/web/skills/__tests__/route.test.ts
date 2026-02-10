import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import { GET } from "../route";

beforeEach(() => {
  // Register base handlers for GitHub API
  server.use(
    // Mock GitHub API - get repo contents
    http.get("https://api.github.com/repos/vm0-ai/vm0-skills/contents", () => {
      return HttpResponse.json([
        { name: "slack", type: "dir" },
        { name: "github", type: "dir" },
        { name: "notion", type: "dir" },
        { name: "docs", type: "dir" }, // Should be filtered out
        { name: "README.md", type: "file" }, // Should be filtered out
      ]);
    }),

    // Mock GitHub raw content - SKILL.md files
    http.get(
      "https://raw.githubusercontent.com/vm0-ai/vm0-skills/main/:skillName/SKILL.md",
      () => {
        return HttpResponse.text("Test skill description", { status: 404 });
      },
    ),
  );
});

describe("GET /api/web/skills", () => {
  it("should return skills list with metadata", async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.total).toBeGreaterThan(0);
    expect(data.skills).toBeInstanceOf(Array);
    expect(data.skillsByCategory).toBeDefined();

    // Check if skills have required fields
    const firstSkill = data.skills[0];
    expect(firstSkill).toHaveProperty("name");
    expect(firstSkill).toHaveProperty("description");
    expect(firstSkill).toHaveProperty("category");
    expect(firstSkill).toHaveProperty("logo");
    expect(firstSkill).toHaveProperty("docsUrl");
  });

  it("should handle GitHub API errors gracefully", async () => {
    // Override handler to return error
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0-skills/contents",
        () => {
          return HttpResponse.json(
            { message: "API rate limit exceeded" },
            { status: 403 },
          );
        },
      ),
    );

    await expect(GET()).rejects.toThrow("Failed to fetch skills list");
  });

  it("should filter out non-directory items", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0-skills/contents",
        () => {
          return HttpResponse.json([
            { name: "slack", type: "dir" },
            { name: "README.md", type: "file" },
            { name: ".gitignore", type: "file" },
          ]);
        },
      ),
    );

    const response = await GET();
    const data = await response.json();

    // Should only include slack (other items filtered out)
    expect(data.skills.length).toBe(1);
    expect(data.skills[0].name).toMatch(/slack/i);
  });

  it("should categorize skills correctly using curated metadata", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0-skills/contents",
        () => {
          return HttpResponse.json([
            { name: "slack", type: "dir" },
            { name: "github", type: "dir" },
          ]);
        },
      ),
    );

    const response = await GET();
    const data = await response.json();

    // Slack has curated metadata with Communication category
    const slackSkill = data.skills.find((s: { name: string }) =>
      s.name.toLowerCase().includes("slack"),
    );
    expect(slackSkill).toBeDefined();
    expect(slackSkill?.category).toBe("Communication");

    // GitHub has curated metadata with Development category
    const githubSkill = data.skills.find((s: { name: string }) =>
      s.name.toLowerCase().includes("github"),
    );
    expect(githubSkill).toBeDefined();
    expect(githubSkill?.category).toBe("Development");
  });
});
