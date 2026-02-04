import { describe, it, expect } from "vitest";
import {
  parseScopedReference,
  formatScopedReference,
  isLegacySystemTemplate,
  resolveImageReference,
  parseImageReferenceWithTag,
  generateScopedE2bAlias,
  isSystemScope,
  isValidSystemTag,
  resolveSystemImageToE2b,
  getLegacySystemTemplateWarning,
  SYSTEM_SCOPE_SLUG,
  SYSTEM_IMAGE_CLAUDE_CODE,
  SYSTEM_IMAGE_CODEX,
  SYSTEM_IMAGES,
  SYSTEM_VALID_TAGS,
} from "../scope-reference";

describe("parseScopedReference", () => {
  it("parses valid scope/name format", () => {
    const result = parseScopedReference("myorg/my-image");
    expect(result).toEqual({ scope: "myorg", name: "my-image" });
  });

  it("parses scope with numbers", () => {
    const result = parseScopedReference("user123/image-v2");
    expect(result).toEqual({ scope: "user123", name: "image-v2" });
  });

  it("throws for missing / separator", () => {
    expect(() => parseScopedReference("myorg")).toThrow("missing / separator");
  });

  it("throws for empty scope", () => {
    expect(() => parseScopedReference("/my-image")).toThrow("empty scope");
  });

  it("throws for empty name", () => {
    expect(() => parseScopedReference("myorg/")).toThrow("empty name");
  });
});

describe("formatScopedReference", () => {
  it("formats scope and name correctly", () => {
    expect(formatScopedReference("myorg", "my-image")).toBe("myorg/my-image");
  });

  it("handles special characters in name", () => {
    expect(formatScopedReference("user", "image-v2")).toBe("user/image-v2");
  });
});

describe("isLegacySystemTemplate", () => {
  it("returns true for vm0- prefix", () => {
    expect(isLegacySystemTemplate("vm0-claude-code")).toBe(true);
    expect(isLegacySystemTemplate("vm0-base")).toBe(true);
  });

  it("returns false for non-vm0 prefix", () => {
    expect(isLegacySystemTemplate("my-image")).toBe(false);
    expect(isLegacySystemTemplate("scope/vm0-image")).toBe(false);
    expect(isLegacySystemTemplate("vm1-image")).toBe(false);
  });
});

describe("resolveImageReference", () => {
  it("passes through legacy vm0-* templates", () => {
    const result = resolveImageReference("vm0-claude-code");
    expect(result).toEqual({
      name: "vm0-claude-code",
      isLegacy: true,
    });
  });

  it("legacy templates don't require userScopeSlug", () => {
    const result = resolveImageReference("vm0-base");
    expect(result.isLegacy).toBe(true);
  });

  it("parses explicit scope/name format", () => {
    const result = resolveImageReference("myorg/my-image");
    expect(result).toEqual({
      scope: "myorg",
      name: "my-image",
      isLegacy: false,
    });
  });

  it("explicit scope doesn't require userScopeSlug", () => {
    const result = resolveImageReference("other/image");
    expect(result.scope).toBe("other");
  });

  it("uses user scope for implicit references", () => {
    const result = resolveImageReference("my-image", "myuser");
    expect(result).toEqual({
      scope: "myuser",
      name: "my-image",
      isLegacy: false,
    });
  });

  it("throws for implicit reference without userScopeSlug", () => {
    expect(() => resolveImageReference("my-image")).toThrow(
      "Please set up your scope first",
    );
  });

  describe("case normalization", () => {
    it("normalizes explicit scope and name to lowercase", () => {
      const result = resolveImageReference("MyOrg/My-Image");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        isLegacy: false,
      });
    });

    it("normalizes uppercase scope and name to lowercase", () => {
      const result = resolveImageReference("LANCY/MY-IMAGE");
      expect(result).toEqual({
        scope: "lancy",
        name: "my-image",
        isLegacy: false,
      });
    });

    it("normalizes implicit name to lowercase", () => {
      const result = resolveImageReference("My-Image", "myuser");
      expect(result).toEqual({
        scope: "myuser",
        name: "my-image",
        isLegacy: false,
      });
    });

    it("does not normalize legacy templates", () => {
      // Legacy templates are passed through as-is
      const result = resolveImageReference("vm0-claude-code");
      expect(result.name).toBe("vm0-claude-code");
    });
  });
});

describe("parseImageReferenceWithTag", () => {
  describe("legacy vm0-* templates", () => {
    it("passes through legacy templates without tag parsing", () => {
      const result = parseImageReferenceWithTag("vm0-claude-code");
      expect(result).toEqual({
        name: "vm0-claude-code",
        isLegacy: true,
      });
    });

    it("does not require userScopeSlug for legacy templates", () => {
      const result = parseImageReferenceWithTag("vm0-base");
      expect(result.isLegacy).toBe(true);
    });
  });

  describe("explicit scope/name format", () => {
    it("parses scope/name without tag", () => {
      const result = parseImageReferenceWithTag("myorg/my-image");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: undefined,
        isLegacy: false,
      });
    });

    it("parses scope/name:latest", () => {
      const result = parseImageReferenceWithTag("myorg/my-image:latest");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: "latest",
        isLegacy: false,
      });
    });

    it("parses scope/name with version ID", () => {
      const result = parseImageReferenceWithTag("myorg/my-image:a1b2c3d4");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: "a1b2c3d4",
        isLegacy: false,
      });
    });

    it("does not require userScopeSlug for explicit scope", () => {
      const result = parseImageReferenceWithTag("other/image:v1");
      expect(result.scope).toBe("other");
      expect(result.tag).toBe("v1");
    });

    it("throws for empty tag after colon", () => {
      expect(() => parseImageReferenceWithTag("myorg/my-image:")).toThrow(
        "empty tag after colon",
      );
    });

    it("throws for empty scope", () => {
      expect(() => parseImageReferenceWithTag("/my-image")).toThrow(
        "empty scope",
      );
    });

    it("throws for empty name", () => {
      expect(() => parseImageReferenceWithTag("myorg/")).toThrow("empty name");
    });

    it("throws for empty name with tag", () => {
      expect(() => parseImageReferenceWithTag("myorg/:latest")).toThrow(
        "empty name",
      );
    });
  });

  describe("implicit format with user scope", () => {
    it("parses name without tag", () => {
      const result = parseImageReferenceWithTag("my-image", "myuser");
      expect(result).toEqual({
        scope: "myuser",
        name: "my-image",
        tag: undefined,
        isLegacy: false,
      });
    });

    it("parses name:latest", () => {
      const result = parseImageReferenceWithTag("my-image:latest", "myuser");
      expect(result).toEqual({
        scope: "myuser",
        name: "my-image",
        tag: "latest",
        isLegacy: false,
      });
    });

    it("parses name with version ID", () => {
      const result = parseImageReferenceWithTag("my-image:a1b2c3d4", "myuser");
      expect(result).toEqual({
        scope: "myuser",
        name: "my-image",
        tag: "a1b2c3d4",
        isLegacy: false,
      });
    });

    it("throws for implicit reference without userScopeSlug", () => {
      expect(() => parseImageReferenceWithTag("my-image")).toThrow(
        "Please set up your scope first",
      );
    });

    it("throws for implicit reference with tag without userScopeSlug", () => {
      expect(() => parseImageReferenceWithTag("my-image:latest")).toThrow(
        "Please set up your scope first",
      );
    });

    it("throws for empty tag after colon", () => {
      expect(() => parseImageReferenceWithTag("my-image:", "myuser")).toThrow(
        "empty tag after colon",
      );
    });

    it("throws for empty name", () => {
      expect(() => parseImageReferenceWithTag(":latest", "myuser")).toThrow(
        "empty name",
      );
    });
  });

  describe("case normalization", () => {
    it("normalizes explicit scope and name to lowercase", () => {
      const result = parseImageReferenceWithTag("VM0/Claude-Code:latest");
      expect(result).toEqual({
        scope: "vm0",
        name: "claude-code",
        tag: "latest",
        isLegacy: false,
      });
    });

    it("normalizes uppercase scope and name to lowercase", () => {
      const result = parseImageReferenceWithTag("LANCY/MY-IMAGE");
      expect(result).toEqual({
        scope: "lancy",
        name: "my-image",
        tag: undefined,
        isLegacy: false,
      });
    });

    it("normalizes implicit name to lowercase", () => {
      const result = parseImageReferenceWithTag("My-Image:latest", "myuser");
      expect(result).toEqual({
        scope: "myuser",
        name: "my-image",
        tag: "latest",
        isLegacy: false,
      });
    });

    it("preserves tag case", () => {
      // Tags should preserve original case (version hashes, etc.)
      const result = parseImageReferenceWithTag("myorg/my-image:DeadBeef");
      expect(result.tag).toBe("DeadBeef");
    });

    it("does not normalize legacy templates", () => {
      const result = parseImageReferenceWithTag("vm0-claude-code");
      expect(result.name).toBe("vm0-claude-code");
    });
  });
});

describe("generateScopedE2bAlias", () => {
  it("generates correct format", () => {
    const result = generateScopedE2bAlias(
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "my-image",
      "deadbeef",
    );
    expect(result).toBe(
      "scope-a1b2c3d4-e5f6-7890-abcd-ef1234567890-image-my-image-version-deadbeef",
    );
  });

  it("sanitizes uppercase characters", () => {
    const result = generateScopedE2bAlias("A1B2C3D4", "MyImage", "DEADBEEF");
    expect(result).toBe("scope-a1b2c3d4-image-myimage-version-deadbeef");
  });

  it("sanitizes invalid characters in name", () => {
    const result = generateScopedE2bAlias(
      "12345678",
      "my_image@v1",
      "abcd1234",
    );
    expect(result).toBe("scope-12345678-image-my-image-v1-version-abcd1234");
  });
});

describe("system scope constants", () => {
  it("has correct system scope slug", () => {
    expect(SYSTEM_SCOPE_SLUG).toBe("vm0");
  });

  it("has correct system image names", () => {
    expect(SYSTEM_IMAGE_CLAUDE_CODE).toBe("claude-code");
    expect(SYSTEM_IMAGE_CODEX).toBe("codex");
  });

  it("has correct system images array", () => {
    expect(SYSTEM_IMAGES).toEqual([
      "claude-code",
      "codex",
      "claude-code-github",
      "codex-github",
    ]);
  });

  it("has correct valid tags", () => {
    expect(SYSTEM_VALID_TAGS).toEqual(["latest"]);
  });
});

describe("isSystemScope", () => {
  it("returns true for vm0 scope", () => {
    expect(isSystemScope("vm0")).toBe(true);
  });

  it("returns false for other scopes", () => {
    expect(isSystemScope("myuser")).toBe(false);
    expect(isSystemScope("vm0-extra")).toBe(false);
    expect(isSystemScope("VM0")).toBe(false);
  });
});

describe("isValidSystemTag", () => {
  it("returns true for undefined (default)", () => {
    expect(isValidSystemTag(undefined)).toBe(true);
  });

  it("returns true for latest", () => {
    expect(isValidSystemTag("latest")).toBe(true);
  });

  it("returns false for dev (no longer supported)", () => {
    expect(isValidSystemTag("dev")).toBe(false);
  });

  it("returns false for hash versions", () => {
    expect(isValidSystemTag("a1b2c3d4")).toBe(false);
    expect(isValidSystemTag("abc123")).toBe(false);
  });

  it("returns false for other tags", () => {
    expect(isValidSystemTag("v1.0")).toBe(false);
    expect(isValidSystemTag("production")).toBe(false);
  });
});

describe("resolveSystemImageToE2b", () => {
  describe("claude-code conversions", () => {
    it("converts vm0/claude-code to vm0-claude-code", () => {
      const result = resolveSystemImageToE2b("claude-code");
      expect(result.e2bTemplate).toBe("vm0-claude-code");
    });

    it("converts vm0/claude-code:latest to vm0-claude-code", () => {
      const result = resolveSystemImageToE2b("claude-code", "latest");
      expect(result.e2bTemplate).toBe("vm0-claude-code");
    });
  });

  describe("codex conversions", () => {
    it("converts vm0/codex to vm0-codex", () => {
      const result = resolveSystemImageToE2b("codex");
      expect(result.e2bTemplate).toBe("vm0-codex");
    });

    it("converts vm0/codex:latest to vm0-codex", () => {
      const result = resolveSystemImageToE2b("codex", "latest");
      expect(result.e2bTemplate).toBe("vm0-codex");
    });
  });

  describe("error cases", () => {
    it("throws for unknown system image", () => {
      expect(() => resolveSystemImageToE2b("unknown-image")).toThrow(
        "Unknown system image: vm0/unknown-image",
      );
    });

    it("error message lists available images", () => {
      expect(() => resolveSystemImageToE2b("unknown-image")).toThrow(
        "vm0/claude-code, vm0/codex",
      );
    });

    it("throws for :dev tag (no longer supported)", () => {
      expect(() => resolveSystemImageToE2b("claude-code", "dev")).toThrow(
        'Invalid tag ":dev" for system image',
      );
    });

    it("throws for hash version tag", () => {
      expect(() => resolveSystemImageToE2b("claude-code", "a1b2c3d4")).toThrow(
        'Invalid tag ":a1b2c3d4" for system image',
      );
    });

    it("throws for arbitrary tag", () => {
      expect(() => resolveSystemImageToE2b("claude-code", "v1.0")).toThrow(
        'Invalid tag ":v1.0" for system image',
      );
    });
  });
});

describe("getLegacySystemTemplateWarning", () => {
  describe("claude-code legacy formats", () => {
    it("returns warning for vm0-claude-code", () => {
      const warning = getLegacySystemTemplateWarning("vm0-claude-code");
      expect(warning).toContain("deprecated");
      expect(warning).toContain("vm0/claude-code");
    });
  });

  describe("codex legacy formats", () => {
    it("returns warning for vm0-codex", () => {
      const warning = getLegacySystemTemplateWarning("vm0-codex");
      expect(warning).toContain("deprecated");
      expect(warning).toContain("vm0/codex");
    });
  });

  describe("other legacy formats", () => {
    it("returns warning for vm0-github-cli", () => {
      const warning = getLegacySystemTemplateWarning("vm0-github-cli");
      expect(warning).toContain("deprecated");
      expect(warning).toContain("apps: [github]");
    });

    it("returns generic warning for other vm0-* formats", () => {
      const warning = getLegacySystemTemplateWarning("vm0-other-template");
      expect(warning).toContain("deprecated");
    });
  });

  it("returns undefined for non-legacy formats", () => {
    expect(getLegacySystemTemplateWarning("vm0/claude-code")).toBeUndefined();
    expect(getLegacySystemTemplateWarning("vm0/codex")).toBeUndefined();
    expect(getLegacySystemTemplateWarning("my-image")).toBeUndefined();
    expect(getLegacySystemTemplateWarning("myorg/image")).toBeUndefined();
  });
});
