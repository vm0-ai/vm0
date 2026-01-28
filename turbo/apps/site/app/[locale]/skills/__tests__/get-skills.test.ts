import { describe, it, expect } from "vitest";
import { server } from "../../../../src/mocks/server";
import { http, HttpResponse } from "msw";
import { getSkills } from "../get-skills";
import { SKILLS_API_URL } from "../constants";

describe("getSkills", () => {
  it("should fetch skills from web app API successfully", async () => {
    server.use(
      http.get(SKILLS_API_URL, () => {
        return HttpResponse.json({
          success: true,
          skills: [
            {
              name: "Slack",
              category: "Communication",
              description: "Slack integration",
            },
            {
              name: "GitHub",
              category: "Development",
              description: "GitHub integration",
            },
            {
              name: "Notion",
              category: "Productivity",
              description: "Notion integration",
            },
          ],
        });
      }),
    );

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
      http.get(SKILLS_API_URL, () => {
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
      http.get(SKILLS_API_URL, () => {
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
});
