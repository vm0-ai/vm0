import { describe, it, expect } from "vitest";
import {
  parseScopedReference,
  formatScopedReference,
  isLegacySystemTemplate,
  resolveImageReference,
  parseImageReferenceWithTag,
  generateScopedE2bAlias,
} from "../scope-reference";

describe("parseScopedReference", () => {
  it("parses valid @scope/name format", () => {
    const result = parseScopedReference("@myorg/my-image");
    expect(result).toEqual({ scope: "myorg", name: "my-image" });
  });

  it("parses scope with numbers", () => {
    const result = parseScopedReference("@user123/image-v2");
    expect(result).toEqual({ scope: "user123", name: "image-v2" });
  });

  it("throws for missing @ prefix", () => {
    expect(() => parseScopedReference("myorg/my-image")).toThrow(
      "must start with @",
    );
  });

  it("throws for missing / separator", () => {
    expect(() => parseScopedReference("@myorg")).toThrow("missing / separator");
  });

  it("throws for empty scope", () => {
    expect(() => parseScopedReference("@/my-image")).toThrow("empty scope");
  });

  it("throws for empty name", () => {
    expect(() => parseScopedReference("@myorg/")).toThrow("empty name");
  });
});

describe("formatScopedReference", () => {
  it("formats scope and name correctly", () => {
    expect(formatScopedReference("myorg", "my-image")).toBe("@myorg/my-image");
  });

  it("handles special characters in name", () => {
    expect(formatScopedReference("user", "image-v2")).toBe("@user/image-v2");
  });
});

describe("isLegacySystemTemplate", () => {
  it("returns true for vm0- prefix", () => {
    expect(isLegacySystemTemplate("vm0-claude-code")).toBe(true);
    expect(isLegacySystemTemplate("vm0-base")).toBe(true);
  });

  it("returns false for non-vm0 prefix", () => {
    expect(isLegacySystemTemplate("my-image")).toBe(false);
    expect(isLegacySystemTemplate("@scope/vm0-image")).toBe(false);
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

  it("parses explicit @scope/name format", () => {
    const result = resolveImageReference("@myorg/my-image");
    expect(result).toEqual({
      scope: "myorg",
      name: "my-image",
      isLegacy: false,
    });
  });

  it("explicit scope doesn't require userScopeSlug", () => {
    const result = resolveImageReference("@other/image");
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

  describe("explicit @scope/name format", () => {
    it("parses @scope/name without tag", () => {
      const result = parseImageReferenceWithTag("@myorg/my-image");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: undefined,
        isLegacy: false,
      });
    });

    it("parses @scope/name:latest", () => {
      const result = parseImageReferenceWithTag("@myorg/my-image:latest");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: "latest",
        isLegacy: false,
      });
    });

    it("parses @scope/name with version ID", () => {
      const result = parseImageReferenceWithTag("@myorg/my-image:a1b2c3d4");
      expect(result).toEqual({
        scope: "myorg",
        name: "my-image",
        tag: "a1b2c3d4",
        isLegacy: false,
      });
    });

    it("does not require userScopeSlug for explicit scope", () => {
      const result = parseImageReferenceWithTag("@other/image:v1");
      expect(result.scope).toBe("other");
      expect(result.tag).toBe("v1");
    });

    it("throws for empty tag after colon", () => {
      expect(() => parseImageReferenceWithTag("@myorg/my-image:")).toThrow(
        "empty tag after colon",
      );
    });

    it("throws for missing / separator", () => {
      expect(() => parseImageReferenceWithTag("@myorg")).toThrow(
        "missing / separator",
      );
    });

    it("throws for empty scope", () => {
      expect(() => parseImageReferenceWithTag("@/my-image")).toThrow(
        "empty scope",
      );
    });

    it("throws for empty name", () => {
      expect(() => parseImageReferenceWithTag("@myorg/")).toThrow("empty name");
    });

    it("throws for empty name with tag", () => {
      expect(() => parseImageReferenceWithTag("@myorg/:latest")).toThrow(
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
