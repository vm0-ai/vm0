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

  it("should append profile block with full metadata as natural language", () => {
    const content = "# Instructions\nDo stuff.";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
      sound: "professional",
    });
    expect(result).toBe(
      "# Instructions\nDo stuff.\n\n<!-- ZERO_PROFILE\nYour name is Aria. Communicate in a clear, polished, and business-appropriate tone. This should be reflected in all your responses.\nZERO_PROFILE -->\n",
    );
  });

  it("should append profile block with only displayName", () => {
    const content = "# Instructions";
    const result = injectMetadataFrontmatter(content, {
      displayName: "Aria",
    });
    expect(result).toBe(
      "# Instructions\n\n<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n",
    );
  });

  it("should append profile block with only sound", () => {
    const content = "# Instructions";
    const result = injectMetadataFrontmatter(content, {
      sound: "friendly",
    });
    expect(result).toBe(
      "# Instructions\n\n<!-- ZERO_PROFILE\nCommunicate in a warm, approachable, and conversational tone. This should be reflected in all your responses.\nZERO_PROFILE -->\n",
    );
  });

  it("should use sound value directly for unknown tones", () => {
    const content = "# Instructions";
    const result = injectMetadataFrontmatter(content, {
      sound: "playful",
    });
    expect(result).toContain("Communicate in a playful tone.");
  });

  it("should replace existing profile block", () => {
    const content =
      "# Instructions\nDo stuff.\n\n<!-- ZERO_PROFILE\nYour name is OldName.\nZERO_PROFILE -->\n";
    const result = injectMetadataFrontmatter(content, {
      displayName: "NewName",
      sound: "direct",
    });
    expect(result).toContain("Your name is NewName.");
    expect(result).toContain("concise, to the point, and no-nonsense");
    expect(result).not.toContain("OldName");
  });

  it("should handle empty content with metadata", () => {
    const result = injectMetadataFrontmatter("", {
      displayName: "Aria",
    });
    expect(result).toBe(
      "<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n",
    );
  });

  it("should describe all known tones correctly", () => {
    for (const tone of ["professional", "friendly", "direct", "supportive"]) {
      const result = injectMetadataFrontmatter("test", { sound: tone });
      expect(result).toContain("Communicate in a ");
      expect(result).toContain("tone.");
    }
  });
});

describe("stripMetadataFrontmatter", () => {
  it("should return content unchanged when no profile block", () => {
    const content = "# Instructions\nDo stuff.";
    expect(stripMetadataFrontmatter(content)).toBe(content);
  });

  it("should strip profile block", () => {
    const content =
      "# Instructions\n\n<!-- ZERO_PROFILE\nYour name is Aria. Communicate in a clear, polished, and business-appropriate tone. This should be reflected in all your responses.\nZERO_PROFILE -->\n";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions");
  });

  it("should preserve content before profile block", () => {
    const content =
      "# Instructions\nDo stuff.\n\n<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n";
    expect(stripMetadataFrontmatter(content)).toBe("# Instructions\nDo stuff.");
  });

  it("should handle content with only profile block", () => {
    const content = "<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n";
    expect(stripMetadataFrontmatter(content)).toBe("");
  });

  it("should be the inverse of injectMetadataFrontmatter", () => {
    const original = "# Instructions\nDo stuff.";
    const injected = injectMetadataFrontmatter(original, {
      displayName: "Aria",
      sound: "professional",
    });
    expect(stripMetadataFrontmatter(injected)).toBe(original);
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
    const malicious = "<!-- ZERO_PROFILE\n" + "a\n".repeat(10000);
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe(malicious.trim());
  });

  it("should handle repeated opening markers in linear time", () => {
    const malicious = "<!-- ZERO_PROFILE\n".repeat(10000);
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toBe(malicious.trim());
  });

  it("should handle nested-looking markers with one closer", () => {
    const malicious =
      "<!-- ZERO_PROFILE\n".repeat(100) + "payload\n" + "ZERO_PROFILE -->\n";
    const start = performance.now();
    const result = stripMetadataFrontmatter(malicious);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // The regex matches from the first opener to the closer
    expect(result).toBe("");
  });

  it("should correctly strip a valid block in large content", () => {
    const prefix = "line\n".repeat(5000);
    const block = "<!-- ZERO_PROFILE\nYour name is Aria.\nZERO_PROFILE -->\n";
    const suffix = "line\n".repeat(5000);
    const content = prefix + block + suffix;
    const start = performance.now();
    const result = stripMetadataFrontmatter(content);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).not.toContain("ZERO_PROFILE");
  });

  it("should handle injectMetadataFrontmatter with repeated markers in linear time", () => {
    const malicious = "<!-- ZERO_PROFILE\n".repeat(10000);
    const start = performance.now();
    const result = injectMetadataFrontmatter(malicious, {
      displayName: "Test",
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result).toContain("Your name is Test.");
  });
});

describe("legacy migration", () => {
  it("should replace old frontmatter with new profile block on inject", () => {
    const content =
      "---\nname: OldName\ntone: casual\n---\n\n# Instructions\nDo stuff.";
    const result = injectMetadataFrontmatter(content, {
      displayName: "NewName",
      sound: "professional",
    });
    expect(result).not.toContain("---");
    expect(result).toContain("<!-- ZERO_PROFILE");
    expect(result).toContain("Your name is NewName.");
    expect(result).toContain("# Instructions\nDo stuff.");
  });
});
