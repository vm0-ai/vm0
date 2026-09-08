import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import {
  API_TEST_CONNECTOR_FIREWALL_CONFIGS,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();

// One process-local sequence owns the history in this isolated test module.
// Catalog namespaces remain unique across workers; no shared cache reset is used.
test("observes bounded projection reuse without changing the run selection cache", async () => {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  const catalogVersion = `projection-observations-${randomUUID()}`;
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", `test-${randomUUID()}`);
  await installApiTestConnectorCatalog({
    catalogVersion,
    runtimeProjection: true,
  });
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Projection observation agent",
    description: "Exercises process-local projection reuse observations.",
    visibility: "private",
  });
  const accessToken = `projection-access-${randomUUID()}`;
  await createFirewallApi(context).seedTestConnector(actor, {
    connectorSlug: "x",
    authMethod: "oauth",
    accessToken,
    refreshToken: "projection-refresh-token",
  });
  const otherConnectorSlugs = API_TEST_CONNECTOR_FIREWALL_CONFIGS.map(
    (firewall) => {
      return firewall.name;
    },
  )
    .filter((slug) => {
      return slug !== "x" && slug !== "nintendo-store";
    })
    .slice(0, 16);
  expect(otherConnectorSlugs).toHaveLength(16);

  const createObservedRun = async (
    scope: number,
    observation: string,
    outcome = "miss",
    normalize = false,
  ) => {
    const connectorSlugs =
      scope === 0
        ? ["x"]
        : ["x", ...otherConnectorSlugs.slice(scope - 1, scope)];
    await api.enableAgentConnectors(
      actor,
      agent.agentId,
      normalize
        ? [...connectorSlugs].reverse().concat(connectorSlugs)
        : connectorSlugs,
    );
    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "Observe scoped projection reuse",
      modelProvider: "anthropic-api-key",
    });
    const events = context.mocks.axiom.sdkIngest.mock.calls.flatMap(
      ([dataset, entries]) => {
        return dataset === "vm0-sandbox-op-log-dev" && Array.isArray(entries)
          ? entries.filter(
              (entry: unknown): entry is Record<string, unknown> => {
                return (
                  typeof entry === "object" &&
                  entry !== null &&
                  "run_id" in entry &&
                  entry.run_id === run.runId
                );
              },
            )
          : [];
      },
    );
    const loads = events.filter((event) => {
      return (
        event.op_type === "api_dispatch_connector_catalog_load_runtime_snapshot"
      );
    });
    expect(loads).toHaveLength(1);
    expect(loads[0]).toStrictEqual(
      expect.objectContaining({
        connector_catalog_projection_cache_outcome: outcome,
        connector_catalog_runtime_selection_source: "projection",
        connector_catalog_projection_cache_observation: observation,
      }),
    );
    expect(
      events.filter((event) => {
        return (
          event.op_type ===
          "api_dispatch_connector_catalog_query_projection_identity"
        );
      }),
    ).toHaveLength(1);
    if (outcome === "hit") {
      expect(
        events.filter((event) => {
          return (
            event.op_type ===
            "api_dispatch_connector_catalog_query_projection_rows"
          );
        }),
      ).toHaveLength(0);
    }
    const serialized = JSON.stringify(loads);
    for (const connectorSlug of connectorSlugs) {
      expect(serialized).not.toContain(JSON.stringify(connectorSlug));
    }
    for (const privateValue of [
      catalogVersion,
      accessToken,
      "projection-refresh-token",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    await api.requestCancelRun(actor, run.runId, [200]);
  };

  await createObservedRun(0, "first_observation");
  await createObservedRun(0, "reuse_1", "hit", true);
  for (let scope = 1; scope < 16; scope++) {
    await createObservedRun(scope, "not_in_recent_history");
  }
  await createObservedRun(0, "reuse_9_16");
  await createObservedRun(15, "reuse_2");
  await createObservedRun(13, "reuse_3_4");
  await createObservedRun(12, "reuse_5_8");
  await createObservedRun(1, "reuse_9_16");
  await createObservedRun(16, "not_in_recent_history");
  await createObservedRun(2, "not_in_recent_history");
  await createObservedRun(2, "reuse_1", "hit");
});
