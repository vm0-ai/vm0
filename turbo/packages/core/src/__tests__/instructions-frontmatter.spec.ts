import { describe, it, expect } from "vitest";
import {
  injectMetadataFrontmatter,
  stripMetadataFrontmatter,
} from "../instructions-frontmatter";

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

describe("stripMetadataFrontmatter", () => {
  it("should return content unchanged when no frontmatter", () => {
    const content = "# Instructions\nDo stuff.";
    expect(stripMetadataFrontmatter(content)).toBe(content);
  });

  it("should strip name and tone from frontmatter", () => {
    const content =
      "---\nname: Aria\ntone: professional\n---\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions");
  });

  it("should preserve non-metadata frontmatter fields", () => {
    const content =
      "---\nname: Aria\nvm0_secrets:\n  - API_KEY\ntone: friendly\n---\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe(
      "---\nvm0_secrets:\n  - API_KEY\n---\n# Instructions",
    );
  });

  it("should strip only metadata keys and keep the rest intact", () => {
    const content = "---\ncustom: value\nname: Aria\n---\n\nBody text here.";
    expect(stripMetadataFrontmatter(content)).toBe(
      "---\ncustom: value\n---\nBody text here.",
    );
  });

  it("should handle frontmatter with only non-metadata keys", () => {
    const content = "---\nvm0_secrets:\n  - KEY\n---\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe(
      "---\nvm0_secrets:\n  - KEY\n---\n# Instructions",
    );
  });

  it("should handle CRLF line endings in frontmatter delimiter", () => {
    const content = "---\r\nname: Aria\r\n---\r\n\n# Instructions";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions");
  });

  it("should be the inverse of injectMetadataFrontmatter for simple cases", () => {
    const original = "# Instructions\nDo stuff.";
    const injected = injectMetadataFrontmatter(original, {
      displayName: "Aria",
      sound: "professional",
    });
    expect(stripMetadataFrontmatter(injected)).toBe(original);
  });
});
