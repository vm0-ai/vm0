import { randomUUID } from "node:crypto";

import { webhookUsageEventContract } from "@vm0/api-contracts/contracts/webhooks";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { generateSandboxToken } from "../../auth/tokens";
import { usageUnderbillingFields } from "../../usage-underbilling";

const context = testContext();

beforeEach(() => {
  mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
});

describe("agent usage event webhook", () => {
  it("builds alertable API underbilling fields", () => {
    expect(usageUnderbillingFields("run_not_found", "confirmed")).toStrictEqual(
      {
        type: "usage_underbilling",
        reason: "run_not_found",
        underbilling_class: "confirmed",
        component: "api",
      },
    );
  });

  it("returns not found when a usage event targets a missing run", async () => {
    const runId = randomUUID();
    const orgId = `org_usage_missing_${randomUUID().slice(0, 8)}`;
    const userId = `user_usage_missing_${randomUUID().slice(0, 8)}`;
    const sandboxToken = generateSandboxToken(userId, runId, orgId);

    await accept(
      setupApp({ context })(webhookUsageEventContract).send({
        headers: { authorization: `Bearer ${sandboxToken}` },
        body: {
          runId,
          events: [
            {
              idempotencyKey: randomUUID(),
              kind: "connector",
              provider: "x",
              category: "tweet.read",
              quantity: 1,
            },
          ],
        },
      }),
      [404],
    );
  });
});
