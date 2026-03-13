import { describe, it, expect } from "vitest";
import {
  isLegacySystemTemplate,
  isValidSystemTag,
  resolveSystemImageToE2b,
  getLegacySystemTemplateWarning,
  SYSTEM_IMAGE_CLAUDE_CODE,
  SYSTEM_IMAGE_CODEX,
  SYSTEM_IMAGES,
  SYSTEM_VALID_TAGS,
} from "../org-reference";

describe("isLegacySystemTemplate", () => {
  it("returns true for vm0- prefix", () => {
    expect(isLegacySystemTemplate("vm0-claude-code")).toBe(true);
    expect(isLegacySystemTemplate("vm0-base")).toBe(true);
  });

  it("returns false for non-vm0 prefix", () => {
    expect(isLegacySystemTemplate("my-image")).toBe(false);
    expect(isLegacySystemTemplate("org/vm0-image")).toBe(false);
    expect(isLegacySystemTemplate("vm1-image")).toBe(false);
  });
});

describe("system image constants", () => {
  it("has correct system image names", () => {
    expect(SYSTEM_IMAGE_CLAUDE_CODE).toBe("claude-code");
    expect(SYSTEM_IMAGE_CODEX).toBe("codex");
  });

  it("has correct system images array", () => {
    expect(SYSTEM_IMAGES).toEqual(["claude-code", "codex"]);
  });

  it("has correct valid tags", () => {
    expect(SYSTEM_VALID_TAGS).toEqual(["latest"]);
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

  describe("legacy github aliases", () => {
    it("resolves claude-code-github to vm0-claude-code", () => {
      const result = resolveSystemImageToE2b("claude-code-github");
      expect(result.e2bTemplate).toBe("vm0-claude-code");
    });

    it("resolves codex-github to vm0-codex", () => {
      const result = resolveSystemImageToE2b("codex-github");
      expect(result.e2bTemplate).toBe("vm0-codex");
    });

    it("resolves claude-code-github:latest to vm0-claude-code", () => {
      const result = resolveSystemImageToE2b("claude-code-github", "latest");
      expect(result.e2bTemplate).toBe("vm0-claude-code");
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
      expect(warning).toContain("GitHub CLI is now included in the base image");
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
