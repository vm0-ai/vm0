import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getEdition, isCommunityEdition, isCloudEdition } from "../edition";

describe("edition", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.VM0_EDITION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getEdition", () => {
    it("returns 'community' when VM0_EDITION is 'community'", () => {
      process.env.VM0_EDITION = "community";
      expect(getEdition()).toBe("community");
    });

    it("returns 'cloud' when VM0_EDITION is 'cloud'", () => {
      process.env.VM0_EDITION = "cloud";
      expect(getEdition()).toBe("cloud");
    });

    it("returns 'cloud' when VM0_EDITION is not set", () => {
      delete process.env.VM0_EDITION;
      expect(getEdition()).toBe("cloud");
    });

    it("returns 'cloud' when VM0_EDITION is invalid", () => {
      process.env.VM0_EDITION = "invalid";
      expect(getEdition()).toBe("cloud");
    });

    it("returns 'cloud' when VM0_EDITION is empty string", () => {
      process.env.VM0_EDITION = "";
      expect(getEdition()).toBe("cloud");
    });
  });

  describe("isCommunityEdition", () => {
    it("returns true when VM0_EDITION is 'community'", () => {
      process.env.VM0_EDITION = "community";
      expect(isCommunityEdition()).toBe(true);
    });

    it("returns false when VM0_EDITION is 'cloud'", () => {
      process.env.VM0_EDITION = "cloud";
      expect(isCommunityEdition()).toBe(false);
    });

    it("returns false when VM0_EDITION is not set", () => {
      delete process.env.VM0_EDITION;
      expect(isCommunityEdition()).toBe(false);
    });
  });

  describe("isCloudEdition", () => {
    it("returns true when VM0_EDITION is 'cloud'", () => {
      process.env.VM0_EDITION = "cloud";
      expect(isCloudEdition()).toBe(true);
    });

    it("returns false when VM0_EDITION is 'community'", () => {
      process.env.VM0_EDITION = "community";
      expect(isCloudEdition()).toBe(false);
    });

    it("returns true when VM0_EDITION is not set (defaults to cloud)", () => {
      delete process.env.VM0_EDITION;
      expect(isCloudEdition()).toBe(true);
    });
  });
});
