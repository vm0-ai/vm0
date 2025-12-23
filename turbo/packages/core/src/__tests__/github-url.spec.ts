import { describe, it, expect } from "vitest";
import { parseGitHubTreeUrl, getSkillNameFromPath } from "../github-url";

describe("parseGitHubTreeUrl", () => {
  it("parses valid GitHub tree URL", () => {
    const url = "https://github.com/owner/repo/tree/main/path/to/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result).not.toBeNull();
    expect(result?.owner).toBe("owner");
    expect(result?.repo).toBe("repo");
    expect(result?.branch).toBe("main");
    expect(result?.path).toBe("path/to/skill");
    expect(result?.skillName).toBe("skill");
    expect(result?.fullPath).toBe("owner/repo/tree/main/path/to/skill");
  });

  it("extracts skill name from single-segment path", () => {
    const url = "https://github.com/owner/repo/tree/main/skill-name";
    const result = parseGitHubTreeUrl(url);

    expect(result?.skillName).toBe("skill-name");
  });

  it("extracts skill name from deep nested path", () => {
    const url = "https://github.com/owner/repo/tree/main/a/b/c/d/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result?.skillName).toBe("skill");
    expect(result?.path).toBe("a/b/c/d/skill");
  });

  it("handles different branch names", () => {
    const url = "https://github.com/owner/repo/tree/develop/path/to/skill";
    const result = parseGitHubTreeUrl(url);

    expect(result?.branch).toBe("develop");
  });

  it("returns null for non-GitHub URLs", () => {
    const url = "https://gitlab.com/owner/repo/tree/main/path";
    const result = parseGitHubTreeUrl(url);

    expect(result).toBeNull();
  });

  it("returns null for GitHub URLs without tree", () => {
    const url = "https://github.com/owner/repo/blob/main/file.ts";
    const result = parseGitHubTreeUrl(url);

    expect(result).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGitHubTreeUrl("not-a-url")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner/repo")).toBeNull();
    expect(parseGitHubTreeUrl("https://github.com/owner/repo/tree")).toBeNull();
    expect(
      parseGitHubTreeUrl("https://github.com/owner/repo/tree/main"),
    ).toBeNull();
  });

  it("preserves full path for unique identification", () => {
    const url = "https://github.com/vm0/skills/tree/main/conventional-commits";
    const result = parseGitHubTreeUrl(url);

    expect(result?.fullPath).toBe("vm0/skills/tree/main/conventional-commits");
  });
});

describe("getSkillNameFromPath", () => {
  it("returns last segment of path", () => {
    expect(getSkillNameFromPath("path/to/skill")).toBe("skill");
  });

  it("handles single segment", () => {
    expect(getSkillNameFromPath("skill")).toBe("skill");
  });

  it("handles deep nesting", () => {
    expect(getSkillNameFromPath("a/b/c/d/skill-name")).toBe("skill-name");
  });

  it("filters empty segments", () => {
    expect(getSkillNameFromPath("path//to///skill")).toBe("skill");
  });

  it("returns path if no segments", () => {
    expect(getSkillNameFromPath("")).toBe("");
  });
});
