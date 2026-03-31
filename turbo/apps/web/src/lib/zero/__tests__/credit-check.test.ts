import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../__tests__/test-helpers";
import {
  createTestCompose,
  getTestZeroAgentId,
  findTestRunsByUserAndPrompt,
  setOrgCredits,
  deleteOrgRow,
  insertOrgDefaultModelProvider,
  insertOrgMembersEntry,
} from "../../../__tests__/api-test-helpers";
import { reloadEnv } from "../../../env";
import { createZeroRun } from "../zero-run-service";
import { isInsufficientCredits } from "../../errors";
import type { TriggerSource } from "@vm0/core";

const context = testContext();

describe("credit check (zero layer)", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const agentName = uniqueId("agent");
    await createTestCompose(agentName);
    agentId = await getTestZeroAgentId(user.orgId, agentName);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
  });

  function baseParams(
    overrides?: Partial<Parameters<typeof createZeroRun>[0]>,
  ) {
    return {
      userId: user.userId,
      prompt: "Credit check test",
      agentId,
      triggerSource: "web" as TriggerSource,
      ...overrides,
    };
  }

  describe("createZeroRun() path", () => {
    it("should allow VM0 run when credits > 0", async () => {
      await setOrgCredits(user.orgId, 100);

      const result = await createZeroRun(baseParams({ modelProvider: "vm0" }));

      expect(result.status).toBe("pending");
      expect(result.runId).toBeDefined();
    });

    it("should reject VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      await expect(
        createZeroRun(baseParams({ modelProvider: "vm0" })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should reject VM0 run when credits are negative", async () => {
      await setOrgCredits(user.orgId, -500);

      await expect(
        createZeroRun(baseParams({ modelProvider: "vm0" })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow non-VM0 run when credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      const result = await createZeroRun(
        baseParams({ modelProvider: "anthropic" }),
      );

      expect(result.status).toBe("pending");
    });

    it("should reject when org default is VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await expect(createZeroRun(baseParams())).rejects.toSatisfy(
        isInsufficientCredits,
      );
    });

    it("should allow when org default is non-VM0 and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);
      await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");

      const result = await createZeroRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should allow when no org default provider and credits = 0", async () => {
      await setOrgCredits(user.orgId, 0);

      // No model provider configured — will throw noModelProvider, not credit error
      // Since checkModelProviderConfigured runs in parallel, we just verify no credit error
      // Actually for createZeroRun, this would fail with noModelProvider
      // because the default compose has skipDefaultApiKey: false (has ANTHROPIC_API_KEY in compose)
      // The default test compose has ANTHROPIC_API_KEY so model provider check is skipped
      const result = await createZeroRun(baseParams());

      expect(result.status).toBe("pending");
    });

    it("should allow when org_metadata row is missing", async () => {
      await deleteOrgRow(user.orgId);

      const result = await createZeroRun(baseParams({ modelProvider: "vm0" }));

      expect(result.status).toBe("pending");
    });

    it("should not enqueue a rejected VM0 run", async () => {
      await setOrgCredits(user.orgId, 0);

      const prompt = "Rejected VM0 run - no enqueue";
      await expect(
        createZeroRun(baseParams({ modelProvider: "vm0", prompt })),
      ).rejects.toSatisfy(isInsufficientCredits);

      // Verify no run record was created (credit check rejects before createRunRecord)
      const runs = await findTestRunsByUserAndPrompt(user.userId, prompt);
      expect(runs).toHaveLength(0);
    });
  });

  describe("member credit cap enforcement", () => {
    it("should reject VM0 run when creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      await expect(
        createZeroRun(baseParams({ modelProvider: "vm0" })),
      ).rejects.toSatisfy(isInsufficientCredits);
    });

    it("should allow non-VM0 run regardless of creditEnabled", async () => {
      await setOrgCredits(user.orgId, 10000);

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      const result = await createZeroRun(
        baseParams({ modelProvider: "anthropic" }),
      );
      expect(result.status).toBe("pending");
    });

    it("should allow VM0 run when creditEnabled is true with cap set", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 10000,
        creditEnabled: true,
      });

      const result = await createZeroRun(baseParams({ modelProvider: "vm0" }));
      expect(result.status).toBe("pending");
    });

    it("should reject VM0 run when default provider is vm0 and creditEnabled is false", async () => {
      await setOrgCredits(user.orgId, 10000);
      await insertOrgDefaultModelProvider(user.orgId, "vm0");

      await insertOrgMembersEntry({
        orgId: user.orgId,
        userId: user.userId,
        creditCap: 100,
        creditEnabled: false,
      });

      await expect(createZeroRun(baseParams())).rejects.toSatisfy(
        isInsufficientCredits,
      );
    });
  });
});
