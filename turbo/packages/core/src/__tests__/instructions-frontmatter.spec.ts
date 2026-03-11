import { describe, it, expect } from "vitest";
import { injectMetadataFrontmatter } from "../instructions-frontmatter";

describe("injectMetadataFrontmatter", () => {
  it("should return content unchanged when metadata is undefined", () => {
    const content = "# Instructions\nDo stuff.";
    expect(injectMetadataFrontmatter(content)).toBe(content);
  });

  it("should return content unchanged when metadata is null", () => {
    const content = "# Instructions\nDo stuff.";
    expect(injectMetadataFrontmatter(content, null)).toBe(content);
  });

  it("should return content unchanged when metadata is empty", () => {
    const content = "# Instructions\nDo stuff.";
    expect(injectMetadataFrontmatter(content, {})).toBe(content);
  });

  it("should return content unchanged when metadata has only falsy fields", () => {
    const content = "# Instructions";
    expect(
      injectMetadataFrontmatter(content, { displayName: "", sound: "" }),
    ).toBe(content);
  });

  it("should prepend frontmatter with full metadata", () => {
    const content = "# Instructions\nDo stuff.";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
      sound: "professional",
    });
    expect(result).toBe(
      "---\nname: Aria\ntone: professional\n---\n\n# Instructions\nDo stuff.",
    );
  });

  it("should prepend frontmatter with only displayName", () => {
    const content = "# Instructions";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
    });
    expect(result).toBe("---\nname: Aria\n---\n\n# Instructions");
  });

  it("should prepend frontmatter with only sound", () => {
    const content = "# Instructions";
    const result = injectMetadataFrontmatter(content, {
      sound: "friendly",
    });
    expect(result).toBe("---\ntone: friendly\n---\n\n# Instructions");
  });

  it("should merge with existing frontmatter preserving other fields", () => {
    const content =
      "---\nvm0_secrets:\n  - API_KEY\n---\n\n# Instructions\nDo stuff.";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
      sound: "professional",
    });
    expect(result).toBe(
      "---\nvm0_secrets:\n  - API_KEY\nname: Aria\ntone: professional\n---\n\n# Instructions\nDo stuff.",
    );
  });

  it("should overwrite existing name and tone in frontmatter", () => {
    const content = "---\nname: OldName\ntone: casual\n---\n\n# Instructions";
    const result = injectMetadataFrontmatter(content, {
      displayName: "NewName",
      sound: "formal",
    });
    expect(result).toBe(
      "---\nname: NewName\ntone: formal\n---\n\n# Instructions",
    );
  });

  it("should handle frontmatter with no trailing content", () => {
    const content = "---\nkey: value\n---\n";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
    });
    expect(result).toBe("---\nkey: value\nname: Aria\n---\n");
  });
});
