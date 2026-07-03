import { describe, it, expect } from "vitest";
import { stripMetadataFrontmatter } from "../instructions-frontmatter";

describe("stripMetadataFrontmatter", () => {
  it("should return content unchanged when no profile block", () => {
    const content = "# Instructions\nDo stuff.";
    expect(stripMetadataFrontmatter(content)).toBe(content);
  });

  it("should strip new profile block", () => {
    const content =
      "[AGENT_PROFILE]\nYour name is Aria. Communicate in a clear, polished, and business-appropriate tone. This should be reflected in all your responses.\n[/AGENT_PROFILE]\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions");
  });

  it("should strip legacy HTML comment profile block", () => {
    const content =
      "# Instructions\n\n<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions");
  });

  it("should preserve content after profile block", () => {
    const content =
      "[AGENT_PROFILE]\nYour name is Aria.\n[/AGENT_PROFILE]\n\n# Instructions\nDo stuff.";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions\nDo stuff.");
  });

  it("should handle content with only profile block", () => {
    const content = "[AGENT_PROFILE]\nYour name is Aria.\n[/AGENT_PROFILE]\n";
    expect(stripMetadataFrontmatter(content)).toBe("");
  });

  it("should strip legacy YAML frontmatter with name and tone", () => {
    const content =
      "---\nname: Boss\ntone: friendly\n---\n\n# Instructions\nDo stuff.";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions\nDo stuff.");
  });

  it("should preserve non-metadata keys in legacy frontmatter", () => {
    const content =
      "---\nname: Boss\nvm0_secrets:\n  - API_KEY\ntone: friendly\n---\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe(
      "---\nvm0_secrets:\n  - API_KEY\n---\n# Instructions",
    );
  });
});

describe("ReDoS regression", () => {
  it("should handle opening marker with no closing marker in linear time", () => {
    const malicious = "[AGENT_PROFILE]\n" + "a\n".repeat(10000);
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe(malicious.trim());
  });

  it("should handle repeated opening markers in linear time", () => {
    const malicious = "[AGENT_PROFILE]\n".repeat(10000);
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe(malicious.trim());
  });

  it("should handle nested-looking markers with one closer", () => {
    const malicious =
      "[AGENT_PROFILE]\n".repeat(100) + "payload\n" + "[/AGENT_PROFILE]\n";
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe("");
  });

  it("should correctly strip a valid block in large content", () => {
    const prefix = "line\n".repeat(5000);
    const block = "[AGENT_PROFILE]\nYour name is Aria.\n[/AGENT_PROFILE]\n";
    const suffix = "line\n".repeat(5000);
    const content = prefix + block + suffix;
    const start = performance.now();
    const result = stripMetadataFrontmatter(content);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).not.toContain("AGENT_PROFILE");
  });

  it("should handle legacy markers in linear time", () => {
    const malicious = "<!-- ZERO_PROFILE\n".repeat(10000);
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe(malicious.trim());
  });
});
