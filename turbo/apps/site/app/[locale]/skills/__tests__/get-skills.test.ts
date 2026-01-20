import { describe, it, expect } from "vitest";
import { server } from "../../../../src/mocks/server";
import { http, HttpResponse } from "msw";
import { getSkills } from "../get-skills";

describe("getSkills", () => {
  it("should fetch skills from web app API successfully", async () => {
    const skills = await getSkills();

    expect(skills).toBeInstanceOf(Array);
    expect(skills.length).toBe(3);
    expect(skills[0]?.name).toBe("Slack");
    expect(skills[0]?.category).toBe("Communication");
    expect(skills[1]?.name).toBe("GitHub");
    expect(skills[2]?.name).toBe("Notion");
  });

  it("should handle API errors gracefully", async () => {
    server.use(
      http.get("http://localhost:3000/api/web/skills", () => {
        return HttpResponse.json(
          { error: "Internal Server Error" },
          { status: 500 },
        );
      }),
    );

    await expect(getSkills()).rejects.toThrow(
      "Failed to fetch skills: Internal Server Error",
    );
  });

  it("should return empty array when API returns no skills", async () => {
    server.use(
      http.get("http://localhost:3000/api/web/skills", () => {
        return HttpResponse.json({
          success: true,
          total: 0,
          skills: [],
        });
      }),
    );

    const skills = await getSkills();

    expect(skills).toEqual([]);
  });

  it("should use WEB_APP_URL environment variable", async () => {
    const originalEnv = process.env.WEB_APP_URL;
    process.env.WEB_APP_URL = "https://test-api.vm0.ai";

    server.use(
      http.get("https://test-api.vm0.ai/api/web/skills", () => {
        return HttpResponse.json({ skills: [] });
      }),
    );

    const skills = await getSkills();

    expect(skills).toEqual([]);

    // Restore
    process.env.WEB_APP_URL = originalEnv;
  });
});
