import { describe, it, expect } from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
import {
  getUserFeatureSwitches,
  updateUserFeatureSwitches,
} from "../feature-switches-service";

const context = testContext();

describe("getUserFeatureSwitches", () => {
  it("should return empty object for new user", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const switches = await getUserFeatureSwitches(orgId, userId);

    expect(switches).toEqual({});
  });
});

describe("updateUserFeatureSwitches", () => {
  it("should create new record with provided switches", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const result = await updateUserFeatureSwitches(orgId, userId, {
      voiceChat: true,
    });

    expect(result).toEqual({ voiceChat: true });
  });

  it("should merge with existing switches", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserFeatureSwitches(orgId, userId, { voiceChat: true });
    const result = await updateUserFeatureSwitches(orgId, userId, {
      lab: false,
    });

    expect(result).toEqual({ voiceChat: true, lab: false });
  });

  it("should override existing switch values", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserFeatureSwitches(orgId, userId, { voiceChat: true });
    const result = await updateUserFeatureSwitches(orgId, userId, {
      voiceChat: false,
    });

    expect(result).toEqual({ voiceChat: false });
  });

  it("should return updated switches on subsequent GET", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await updateUserFeatureSwitches(orgId, userId, {
      voiceChat: true,
      lab: false,
    });

    const switches = await getUserFeatureSwitches(orgId, userId);

    expect(switches).toEqual({ voiceChat: true, lab: false });
  });
});
