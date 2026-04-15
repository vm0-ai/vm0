import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  listOrgVariables,
  setOrgVariable,
  deleteOrgVariable,
  listVariables,
  setVariable,
} from "../variable-service";

vi.mock("@axiomhq/logging");

const context = testContext();

describe("Org-level variable service", () => {
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    orgId = user.orgId;
  });

  describe("CRUD lifecycle", () => {
    it("should return empty list when no org variables exist", async () => {
      const vars = await listOrgVariables(orgId);
      expect(vars).toEqual([]);
    });

    it("should create an org variable", async () => {
      const variable = await setOrgVariable(
        orgId,
        "ORG_ENV",
        "production",
        "Org environment",
      );

      expect(variable.name).toBe("ORG_ENV");
      expect(variable.value).toBe("production");
      expect(variable.description).toBe("Org environment");
      expect(variable.id).toBeDefined();
    });

    it("should list org variables", async () => {
      await setOrgVariable(orgId, "ORG_ENV", "production");

      const vars = await listOrgVariables(orgId);
      expect(vars).toHaveLength(1);
      expect(vars[0]?.name).toBe("ORG_ENV");
    });

    it("should update existing org variable on re-upsert", async () => {
      const first = await setOrgVariable(orgId, "ORG_ENV", "staging");
      const second = await setOrgVariable(orgId, "ORG_ENV", "production");

      expect(second.id).toBe(first.id);
      expect(second.value).toBe("production");
    });

    it("should delete an org variable", async () => {
      await setOrgVariable(orgId, "ORG_ENV", "production");

      await deleteOrgVariable(orgId, "ORG_ENV");

      const vars = await listOrgVariables(orgId);
      expect(vars).toEqual([]);
    });

    it("should throw when deleting non-existent org variable", async () => {
      await expect(deleteOrgVariable(orgId, "ORG_ENV")).rejects.toThrow(
        'Variable "ORG_ENV" not found',
      );
    });
  });

  describe("isolation", () => {
    it("should not return org variables in user variable list", async () => {
      const user = await context.setupUser();
      await setOrgVariable(user.orgId, "SHARED_VAR", "org-value");

      const userVars = await listVariables(user.orgId, user.userId);
      expect(userVars).toEqual([]);
    });

    it("should not return user variables in org variable list", async () => {
      const user = await context.setupUser();
      await setVariable(user.orgId, user.userId, "USER_VAR", "user-value");

      const orgVars = await listOrgVariables(user.orgId);
      expect(orgVars).toEqual([]);
    });

    it("should allow same-name variable for both org and user", async () => {
      const user = await context.setupUser();
      await setOrgVariable(user.orgId, "MY_VAR", "org-value");
      await setVariable(user.orgId, user.userId, "MY_VAR", "user-value");

      const orgVars = await listOrgVariables(user.orgId);
      const userVars = await listVariables(user.orgId, user.userId);

      expect(orgVars).toHaveLength(1);
      expect(orgVars[0]?.name).toBe("MY_VAR");
      expect(orgVars[0]?.value).toBe("org-value");

      expect(userVars).toHaveLength(1);
      expect(userVars[0]?.name).toBe("MY_VAR");
      expect(userVars[0]?.value).toBe("user-value");

      expect(orgVars[0]?.id).not.toBe(userVars[0]?.id);
    });
  });
});
