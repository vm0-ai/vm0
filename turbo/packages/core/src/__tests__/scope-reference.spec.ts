import { describe, it, expect } from "vitest";
import {
  parseScopedReference,
  formatScopedReference,
  isLegacySystemTemplate,
  resolveImageReference,
  generateScopedE2bAlias,
  computeDockerfileVersionHash,
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

describe("computeDockerfileVersionHash", () => {
  it("returns 8 character hash", async () => {
    const result = await computeDockerfileVersionHash("FROM ubuntu:22.04");
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[a-f0-9]{8}$/);
  });

  it("returns consistent hash for same content", async () => {
    const dockerfile = "FROM node:18\nRUN npm install";
    const hash1 = await computeDockerfileVersionHash(dockerfile);
    const hash2 = await computeDockerfileVersionHash(dockerfile);
    expect(hash1).toBe(hash2);
  });

  it("returns different hash for different content", async () => {
    const hash1 = await computeDockerfileVersionHash("FROM ubuntu:22.04");
    const hash2 = await computeDockerfileVersionHash("FROM ubuntu:24.04");
    expect(hash1).not.toBe(hash2);
  });
});
