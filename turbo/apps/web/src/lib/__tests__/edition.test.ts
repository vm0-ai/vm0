import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getEdition, isCommunityEdition, isCloudEdition } from "../edition";

describe("edition", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear all edition-related env vars
    delete process.env.VM0_EDITION;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getEdition", () => {
    describe("explicit VM0_EDITION configuration", () => {
      it("returns 'community' when VM0_EDITION is 'community'", () => {
        process.env.VM0_EDITION = "community";
        expect(getEdition()).toBe("community");
      });

      it("returns 'cloud' when VM0_EDITION is 'cloud'", () => {
        process.env.VM0_EDITION = "cloud";
        expect(getEdition()).toBe("cloud");
      });

      it("explicit VM0_EDITION takes precedence over Clerk keys", () => {
        process.env.VM0_EDITION = "community";
        process.env.CLERK_SECRET_KEY = "sk_test_xxx";
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
        expect(getEdition()).toBe("community");
      });
    });

    describe("auto-detection when VM0_EDITION is not set", () => {
      it("returns 'community' when no Clerk keys are configured", () => {
        delete process.env.VM0_EDITION;
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
        expect(getEdition()).toBe("community");
      });

      it("returns 'community' when only CLERK_SECRET_KEY is set", () => {
        delete process.env.VM0_EDITION;
        process.env.CLERK_SECRET_KEY = "sk_test_xxx";
        delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
        expect(getEdition()).toBe("community");
      });

      it("returns 'community' when only NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set", () => {
        delete process.env.VM0_EDITION;
        delete process.env.CLERK_SECRET_KEY;
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
        expect(getEdition()).toBe("community");
      });

      it("returns 'cloud' when both Clerk keys are configured", () => {
        delete process.env.VM0_EDITION;
        process.env.CLERK_SECRET_KEY = "sk_test_xxx";
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
        expect(getEdition()).toBe("cloud");
      });
    });

    describe("invalid VM0_EDITION values", () => {
      it("falls back to auto-detection for invalid values without Clerk keys", () => {
        process.env.VM0_EDITION = "invalid";
        delete process.env.CLERK_SECRET_KEY;
        delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
        expect(getEdition()).toBe("community");
      });

      it("falls back to auto-detection for invalid values with Clerk keys", () => {
        process.env.VM0_EDITION = "invalid";
        process.env.CLERK_SECRET_KEY = "sk_test_xxx";
        process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
        expect(getEdition()).toBe("cloud");
      });
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

    it("returns true when auto-detected (no Clerk keys)", () => {
      delete process.env.VM0_EDITION;
      delete process.env.CLERK_SECRET_KEY;
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      expect(isCommunityEdition()).toBe(true);
    });

    it("returns false when auto-detected (Clerk keys present)", () => {
      delete process.env.VM0_EDITION;
      process.env.CLERK_SECRET_KEY = "sk_test_xxx";
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
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

    it("returns false when auto-detected (no Clerk keys)", () => {
      delete process.env.VM0_EDITION;
      delete process.env.CLERK_SECRET_KEY;
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
      expect(isCloudEdition()).toBe(false);
    });

    it("returns true when auto-detected (Clerk keys present)", () => {
      delete process.env.VM0_EDITION;
      process.env.CLERK_SECRET_KEY = "sk_test_xxx";
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_xxx";
      expect(isCloudEdition()).toBe(true);
    });
  });
});
