import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { testContext } from "../../../../__tests__/test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  getCount,
  hasDone,
  recordBehavior,
} from "../user-behavior-count-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { userBehaviorCount } from "../../../../db/schema/user-behavior-count";

const BEHAVIOR_AUDIO_INPUT = "audio_input_attempt";
const BEHAVIOR_OTHER = "other_behavior";

const context = testContext();

describe("user-behavior-count-service", () => {
  describe("recordBehavior", () => {
    it("creates a row with count = 1 on first call", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      const count = await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(count).toBe(1);
    });

    it("increments count on subsequent calls", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      const count = await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(count).toBe(3);
    });

    it("preserves first_at and updates last_at on subsequent calls", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();
      // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
      const db = globalThis.services.db;

      const readRow = async () => {
        const [row] = await db
          .select()
          .from(userBehaviorCount)
          .where(
            and(
              eq(userBehaviorCount.orgId, orgId),
              eq(userBehaviorCount.userId, userId),
              eq(userBehaviorCount.behaviorKey, BEHAVIOR_AUDIO_INPUT),
            ),
          )
          .limit(1);
        if (!row) {
          throw new Error("expected row to exist after recordBehavior");
        }
        return row;
      };

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      const after1 = await readRow();

      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      const after2 = await readRow();

      expect(after2.firstAt.getTime()).toBe(after1.firstAt.getTime());
      expect(after2.lastAt.getTime()).toBeGreaterThan(after1.lastAt.getTime());
    });
  });

  describe("getCount", () => {
    it("returns 0 when no row exists", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      const count = await getCount(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(count).toBe(0);
    });

    it("returns the current count after records", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      const count = await getCount(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(count).toBe(2);
    });
  });

  describe("hasDone", () => {
    it("returns false when no row exists", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      const done = await hasDone(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(done).toBe(false);
    });

    it("returns true after at least one record", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      const done = await hasDone(orgId, userId, BEHAVIOR_AUDIO_INPUT);

      expect(done).toBe(true);
    });
  });

  describe("behavior isolation", () => {
    it("tracks different behavior_keys independently for the same user", async () => {
      context.setupMocks();
      const { userId, orgId } = await context.setupUser();

      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      await recordBehavior(orgId, userId, BEHAVIOR_AUDIO_INPUT);
      await recordBehavior(orgId, userId, BEHAVIOR_OTHER);

      expect(await getCount(orgId, userId, BEHAVIOR_AUDIO_INPUT)).toBe(2);
      expect(await getCount(orgId, userId, BEHAVIOR_OTHER)).toBe(1);
    });
  });
});
