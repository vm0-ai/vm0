import { randomUUID } from "node:crypto";

import { DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL } from "@okouai/api-contracts/contracts/model-providers";
import { runnersModelUsageObservationsContract } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { generateSandboxToken } from "../../auth/tokens";
import { runnersRoutes } from "../runners";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  deleteModelStatsObservations,
  readModelStatsObservations,
} from "./helpers/model-stats-state";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);

function officialRunnerHeaders() {
  return {
    authorization:
      "Bearer vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };
}

function client() {
  return setupApp({ context, routes: runnersRoutes })(
    runnersModelUsageObservationsContract,
  );
}

function observation(idempotencyKey: string, model: string) {
  return {
    idempotencyKey,
    model,
    inputTokens: 11,
    outputTokens: 7,
    cacheReadInputTokens: 5,
    cacheCreationInputTokens: 3,
  };
}

describe("POST /api/runners/model-usage-observations", () => {
  it("persists supported observations idempotently and excludes unsupported models", async () => {
    const supportedKey = randomUUID();
    const unsupportedKey = randomUUID();
    const idempotencyKeys = [supportedKey, unsupportedKey];
    onTestFinished(async () => {
      await deleteModelStatsObservations(context, idempotencyKeys);
    });

    const request = {
      headers: officialRunnerHeaders(),
      body: {
        events: [
          observation(supportedKey, DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL),
          observation(unsupportedKey, "unsupported-runner-model"),
        ],
      },
    };

    await expect(
      accept(client().report(request), [200]),
    ).resolves.toMatchObject({
      body: { success: true },
    });
    await expect(
      accept(client().report(request), [200]),
    ).resolves.toMatchObject({
      body: { success: true },
    });

    await expect(
      readModelStatsObservations(context, idempotencyKeys),
    ).resolves.toStrictEqual([
      {
        idempotencyKey: supportedKey,
        aggregatedAt: null,
      },
    ]);
  });

  it("accepts only official runner authentication", async () => {
    const idempotencyKey = randomUUID();
    const body = {
      events: [
        observation(idempotencyKey, DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL),
      ],
    };

    await accept(client().report({ headers: {}, body }), [401]);

    const sandboxToken = generateSandboxToken(
      "user_" + randomUUID(),
      randomUUID(),
      "org_" + randomUUID(),
    );
    await accept(
      client().report({
        headers: { authorization: "Bearer " + sandboxToken },
        body,
      }),
      [401],
    );

    const actor = bdd.user();
    const pat = await runs.createCliToken(actor);
    await accept(
      client().report({
        headers: { authorization: "Bearer " + pat.token },
        body,
      }),
      [403],
    );

    await expect(
      readModelStatsObservations(context, [idempotencyKey]),
    ).resolves.toStrictEqual([]);
  });
});
