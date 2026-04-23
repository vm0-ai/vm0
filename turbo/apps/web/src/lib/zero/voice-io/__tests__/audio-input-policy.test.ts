import { describe, it, expect } from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
import {
  checkAudioInputQuota,
  AUDIO_INPUT_FREE_QUOTA,
  AUDIO_INPUT_BEHAVIOR_KEY,
} from "../audio-input-policy";
import { seedBehaviorCount } from "../../../../__tests__/db-test-seeders/behavior";

const context = testContext();

describe("checkAudioInputQuota", () => {
  describe("free tier", () => {
    it("allows when count is 0 (no usage)", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      const result = await checkAudioInputQuota(orgId, userId, "free");

      expect(result.allowed).toBe(true);
      expect(result.count).toBe(0);
      expect(result.limit).toBe(AUDIO_INPUT_FREE_QUOTA);
    });

    it("allows when count is below the quota boundary (count = 9)", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 9);

      const result = await checkAudioInputQuota(orgId, userId, "free");

      expect(result.allowed).toBe(true);
      expect(result.count).toBe(9);
      expect(result.limit).toBe(AUDIO_INPUT_FREE_QUOTA);
    });

    it("blocks when count equals the quota (count = 10)", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 10);

      const result = await checkAudioInputQuota(orgId, userId, "free");

      expect(result.allowed).toBe(false);
      expect(result.count).toBe(10);
      expect(result.limit).toBe(AUDIO_INPUT_FREE_QUOTA);
    });

    it("blocks when count exceeds the quota (count = 11)", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 11);

      const result = await checkAudioInputQuota(orgId, userId, "free");

      expect(result.allowed).toBe(false);
      expect(result.count).toBe(11);
      expect(result.limit).toBe(AUDIO_INPUT_FREE_QUOTA);
    });
  });

  describe("non-free tiers", () => {
    it("always allows for pro tier regardless of usage", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 20);

      const result = await checkAudioInputQuota(orgId, userId, "pro");

      expect(result.allowed).toBe(true);
      expect(result.limit).toBeNull();
    });

    it("always allows for team tier regardless of usage", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await seedBehaviorCount(orgId, userId, AUDIO_INPUT_BEHAVIOR_KEY, 20);

      const result = await checkAudioInputQuota(orgId, userId, "team");

      expect(result.allowed).toBe(true);
      expect(result.limit).toBeNull();
    });
  });
});
