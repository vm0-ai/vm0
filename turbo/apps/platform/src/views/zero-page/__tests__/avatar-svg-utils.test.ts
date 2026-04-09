/**
 * Tests for avatar-svg-utils.ts — serialization, parsing, and config generation.
 *
 * These are pure utility functions that form the core of the avatar system.
 * Follows the same pattern as parse-schedule-time-string.test.ts for testing
 * deterministic parse/serialize logic.
 */
import { describe, expect, it } from "vitest";
import {
  serializeAvatarSvgConfig,
  parseAvatarSvgConfig,
  type AvatarSvgConfig,
  randomAvatarSvgConfig,
} from "../avatar-svg-utils.ts";
import {
  resolveAvatarSvgConfig,
  resolveAvatarUrl,
  randomPresetAvatar,
} from "../avatar-utils.ts";
import { getAvatarPresets } from "../zero-avatars.ts";

describe("serializeAvatarSvgConfig", () => {
  it("serializes a config to the expected compact string", () => {
    const config: AvatarSvgConfig = {
      rotation: 1,
      skin: 0,
      hairStyle: 3,
      hairColor: 2,
      expression: 1,
      intensity: "d",
    };
    expect(serializeAvatarSvgConfig(config)).toBe("svg:r1s0h3c2f1d");
  });

  it("serializes configs with max values", () => {
    const config: AvatarSvgConfig = {
      rotation: 5,
      skin: 4,
      hairStyle: 5,
      hairColor: 5,
      expression: 5,
      intensity: "h",
    };
    expect(serializeAvatarSvgConfig(config)).toBe("svg:r5s4h5c5f5h");
  });

  it("serializes medium intensity", () => {
    const config: AvatarSvgConfig = {
      rotation: 3,
      skin: 2,
      hairStyle: 1,
      hairColor: 4,
      expression: 2,
      intensity: "m",
    };
    expect(serializeAvatarSvgConfig(config)).toBe("svg:r3s2h1c4f2m");
  });
});

describe("parseAvatarSvgConfig", () => {
  it("parses a valid svg: string back into config", () => {
    const result = parseAvatarSvgConfig("svg:r1s0h3c2f1d");
    expect(result).toStrictEqual({
      rotation: 1,
      skin: 0,
      hairStyle: 3,
      hairColor: 2,
      expression: 1,
      intensity: "d",
    });
  });

  it("parses max values", () => {
    const result = parseAvatarSvgConfig("svg:r5s4h5c5f5h");
    expect(result).toStrictEqual({
      rotation: 5,
      skin: 4,
      hairStyle: 5,
      hairColor: 5,
      expression: 5,
      intensity: "h",
    });
  });

  it("returns null for null input", () => {
    expect(parseAvatarSvgConfig(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseAvatarSvgConfig(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAvatarSvgConfig("")).toBeNull();
  });

  it("returns null for non-svg: prefix", () => {
    expect(parseAvatarSvgConfig("preset:0")).toBeNull();
  });

  it("returns null for invalid body format", () => {
    expect(parseAvatarSvgConfig("svg:invalid")).toBeNull();
  });

  it("returns null for out-of-range rotation (0)", () => {
    expect(parseAvatarSvgConfig("svg:r0s0h3c2f1d")).toBeNull();
  });

  it("returns null for out-of-range rotation (6)", () => {
    expect(parseAvatarSvgConfig("svg:r6s0h3c2f1d")).toBeNull();
  });

  it("returns null for out-of-range skin (5)", () => {
    expect(parseAvatarSvgConfig("svg:r1s5h3c2f1d")).toBeNull();
  });

  it("returns null for invalid intensity character", () => {
    expect(parseAvatarSvgConfig("svg:r1s0h3c2f1x")).toBeNull();
  });
});

describe("serialize/parse roundtrip", () => {
  it("roundtrips correctly for all intensity values", () => {
    for (const intensity of ["d", "m", "h"] as const) {
      const config: AvatarSvgConfig = {
        rotation: 2,
        skin: 1,
        hairStyle: 4,
        hairColor: 3,
        expression: 5,
        intensity,
      };
      const serialized = serializeAvatarSvgConfig(config);
      const parsed = parseAvatarSvgConfig(serialized);
      expect(parsed).toStrictEqual(config);
    }
  });
});

describe("randomAvatarSvgConfig", () => {
  it("generates configs within valid ranges", () => {
    for (let i = 0; i < 20; i++) {
      const config = randomAvatarSvgConfig();
      expect(config.rotation).toBeGreaterThanOrEqual(1);
      expect(config.rotation).toBeLessThanOrEqual(5);
      expect(config.skin).toBeGreaterThanOrEqual(0);
      expect(config.skin).toBeLessThanOrEqual(4);
      expect(config.hairStyle).toBeGreaterThanOrEqual(1);
      expect(config.hairStyle).toBeLessThanOrEqual(5);
      expect(config.hairColor).toBeGreaterThanOrEqual(1);
      expect(config.hairColor).toBeLessThanOrEqual(5);
      expect(config.expression).toBeGreaterThanOrEqual(1);
      expect(config.expression).toBeLessThanOrEqual(5);
      expect(["d", "m", "h"]).toContain(config.intensity);
    }
  });

  it("generates configs that serialize and parse correctly", () => {
    for (let i = 0; i < 10; i++) {
      const config = randomAvatarSvgConfig();
      const serialized = serializeAvatarSvgConfig(config);
      expect(serialized).toMatch(/^svg:r[1-5]s[0-4]h[1-5]c[1-5]f[1-5][dmh]$/);
      expect(parseAvatarSvgConfig(serialized)).toStrictEqual(config);
    }
  });
});

describe("resolveAvatarSvgConfig", () => {
  it("returns null for null input", () => {
    expect(resolveAvatarSvgConfig(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(resolveAvatarSvgConfig(undefined)).toBeNull();
  });

  it("returns preset config for preset:0", () => {
    const result = resolveAvatarSvgConfig("preset:0");
    const presets = getAvatarPresets();
    expect(result).toStrictEqual(presets[0]);
  });

  it("returns preset config for preset:4", () => {
    const result = resolveAvatarSvgConfig("preset:4");
    const presets = getAvatarPresets();
    expect(result).toStrictEqual(presets[4]);
  });

  it("falls back to preset:0 for out-of-range preset index", () => {
    const result = resolveAvatarSvgConfig("preset:999");
    const presets = getAvatarPresets();
    expect(result).toStrictEqual(presets[0]);
  });

  it("returns parsed config for svg: value", () => {
    const result = resolveAvatarSvgConfig("svg:r3s2h1c4f2m");
    expect(result).toStrictEqual({
      rotation: 3,
      skin: 2,
      hairStyle: 1,
      hairColor: 4,
      expression: 2,
      intensity: "m",
    });
  });

  it("returns null for custom URL", () => {
    expect(resolveAvatarSvgConfig("https://example.com/avatar.png")).toBeNull();
  });
});

describe("resolveAvatarUrl", () => {
  it("returns null for null input", () => {
    expect(resolveAvatarUrl(null)).toBeNull();
  });

  it("returns null for preset: values", () => {
    expect(resolveAvatarUrl("preset:0")).toBeNull();
  });

  it("returns null for svg: values", () => {
    expect(resolveAvatarUrl("svg:r1s0h3c2f1d")).toBeNull();
  });

  it("returns the URL for custom upload URLs", () => {
    expect(resolveAvatarUrl("https://example.com/avatar.png")).toBe(
      "https://example.com/avatar.png",
    );
  });
});

describe("randomPresetAvatar", () => {
  it("generates a preset: string", () => {
    const result = randomPresetAvatar();
    expect(result).toMatch(/^preset:\d+$/);
  });

  it("generates a value within the preset range", () => {
    const presets = getAvatarPresets();
    for (let i = 0; i < 20; i++) {
      const result = randomPresetAvatar();
      const idx = Number(result.slice("preset:".length));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(presets.length);
    }
  });
});

describe("getAvatarPresets", () => {
  it("returns 5 preset configs", () => {
    const presets = getAvatarPresets();
    expect(presets).toHaveLength(5);
  });

  it("all presets have valid field ranges", () => {
    const presets = getAvatarPresets();
    for (const p of presets) {
      expect(p.rotation).toBeGreaterThanOrEqual(1);
      expect(p.rotation).toBeLessThanOrEqual(5);
      expect(p.skin).toBeGreaterThanOrEqual(0);
      expect(p.skin).toBeLessThanOrEqual(4);
      expect(p.hairStyle).toBeGreaterThanOrEqual(1);
      expect(p.hairStyle).toBeLessThanOrEqual(5);
      expect(p.hairColor).toBeGreaterThanOrEqual(1);
      expect(p.hairColor).toBeLessThanOrEqual(5);
      expect(p.expression).toBeGreaterThanOrEqual(1);
      expect(p.expression).toBeLessThanOrEqual(5);
      expect(["d", "m", "h"]).toContain(p.intensity);
    }
  });
});
