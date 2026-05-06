import { describe, it, expect } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../../../__tests__/test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { updateUserFeatureSwitches } from "../../user/feature-switches-service";
import { isCodexOauthEligible } from "../codex-oauth-eligibility";

const context = testContext();

describe("isCodexOauthEligible", () => {
  it("returns false when registry default is OFF and no per-user override exists", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const result = await isCodexOauthEligible(orgId, userId);

    expect(result).toBe(false);
  });

  it("returns true when per-user override sets the switch to true", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();
    await updateUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.CodexOauthProvider]: true,
    });

    const result = await isCodexOauthEligible(orgId, userId);

    expect(result).toBe(true);
  });

  it("returns false when per-user override explicitly sets the switch to false", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();
    await updateUserFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.CodexOauthProvider]: false,
    });

    const result = await isCodexOauthEligible(orgId, userId);

    expect(result).toBe(false);
  });
});
