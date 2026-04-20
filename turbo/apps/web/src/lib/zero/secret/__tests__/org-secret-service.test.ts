import { describe, it, expect, beforeEach, vi } from "vitest";
import { testContext } from "../../../../__tests__/test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import {
  listOrgSecrets,
  setOrgSecret,
  deleteOrgSecret,
  listSecrets,
  setSecret,
} from "../secret-service";

vi.mock("@axiomhq/logging");

const context = testContext();

describe("Org-level secret service", () => {
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    orgId = user.orgId;
  });

  describe("CRUD lifecycle", () => {
    it("should return empty list when no org secrets exist", async () => {
      const secrets = await listOrgSecrets(orgId);
      expect(secrets).toEqual([]);
    });

    it("should create an org secret", async () => {
      const secret = await setOrgSecret(orgId, "ORG_API_KEY", "test-value");

      expect(secret.name).toBe("ORG_API_KEY");
      expect(secret.type).toBe("user");
      expect(secret.id).toBeDefined();
    });

    it("should list org secrets", async () => {
      await setOrgSecret(orgId, "ORG_API_KEY", "test-value");

      const secrets = await listOrgSecrets(orgId);
      expect(secrets).toHaveLength(1);
      expect(secrets[0]?.name).toBe("ORG_API_KEY");
    });

    it("should update existing org secret on re-upsert", async () => {
      const first = await setOrgSecret(orgId, "ORG_API_KEY", "value-v1");
      const second = await setOrgSecret(orgId, "ORG_API_KEY", "value-v2");

      expect(second.id).toBe(first.id);
    });

    it("should delete an org secret", async () => {
      await setOrgSecret(orgId, "ORG_API_KEY", "test-value");

      await deleteOrgSecret(orgId, "ORG_API_KEY");

      const secrets = await listOrgSecrets(orgId);
      expect(secrets).toEqual([]);
    });

    it("should throw when deleting non-existent org secret", async () => {
      await expect(deleteOrgSecret(orgId, "ORG_API_KEY")).rejects.toThrow(
        'Secret "ORG_API_KEY" not found',
      );
    });
  });

  describe("isolation", () => {
    it("should not return org secrets in user secret list", async () => {
      const user = await context.setupUser();
      await setOrgSecret(user.orgId, "SHARED_KEY", "org-value");

      const userSecrets = await listSecrets(user.orgId, user.userId);
      expect(userSecrets).toEqual([]);
    });

    it("should not return user secrets in org secret list", async () => {
      const user = await context.setupUser();
      await setSecret(user.orgId, user.userId, "USER_KEY", "user-value");

      const orgSecrets = await listOrgSecrets(user.orgId);
      expect(orgSecrets).toEqual([]);
    });

    it("should allow same-name secret for both org and user", async () => {
      const user = await context.setupUser();
      await setOrgSecret(user.orgId, "API_KEY", "org-value");
      await setSecret(user.orgId, user.userId, "API_KEY", "user-value");

      const orgSecrets = await listOrgSecrets(user.orgId);
      const userSecrets = await listSecrets(user.orgId, user.userId);

      expect(orgSecrets).toHaveLength(1);
      expect(orgSecrets[0]?.name).toBe("API_KEY");

      expect(userSecrets).toHaveLength(1);
      expect(userSecrets[0]?.name).toBe("API_KEY");

      expect(orgSecrets[0]?.id).not.toBe(userSecrets[0]?.id);
    });
  });
});
