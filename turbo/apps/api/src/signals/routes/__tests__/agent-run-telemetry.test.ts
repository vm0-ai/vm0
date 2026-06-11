// Remnant legacy file, kept per api.bdd.md (runners.test.ts / storages.test.ts
// precedent): `sandbox_telemetry` has no API writer in apps/api — the
// telemetry webhook ingests to Axiom datasets only — so the Postgres
// aggregation loop in agentRunTelemetry (agent-run-telemetry.service.ts) is
// reachable only through historical rows seeded directly. Route-level
// telemetry coverage lives in run-reads.bdd.test.ts (RUN-04).
import { runTelemetryContract } from "@vm0/api-contracts/contracts/runs";
import { sandboxTelemetry } from "@vm0/db/schema/sandbox-telemetry";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("GET /api/agent/runs/:id telemetry routes", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  async function setupRun(): Promise<{ readonly runId: string }> {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      fixture,
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      { ...fixture, composeId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return { runId };
  }

  async function insertTelemetry(
    runId: string,
    data: {
      readonly systemLog?: string;
      readonly metrics?: readonly {
        readonly ts: string;
        readonly cpu: number;
        readonly mem_used: number;
        readonly mem_total: number;
        readonly disk_used: number;
        readonly disk_total: number;
      }[];
    },
  ): Promise<void> {
    const db = store.set(writeDb$);
    await db.insert(sandboxTelemetry).values({ runId, data });
  }

  it("aggregates legacy telemetry records from Postgres", async () => {
    const fixture = await setupRun();
    await insertTelemetry(fixture.runId, {
      systemLog: "boot\n",
      metrics: [
        {
          ts: "2026-01-15T10:30:00Z",
          cpu: 0.1,
          mem_used: 10,
          mem_total: 100,
          disk_used: 20,
          disk_total: 200,
        },
      ],
    });
    await insertTelemetry(fixture.runId, {
      systemLog: "ready\n",
      metrics: [
        {
          ts: "2026-01-15T10:31:00Z",
          cpu: 0.2,
          mem_used: 11,
          mem_total: 100,
          disk_used: 21,
          disk_total: 200,
        },
      ],
    });

    const client = setupApp({ context })(runTelemetryContract);
    const response = await accept(
      client.getTelemetry({
        params: { id: fixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.systemLog).toBe("boot\nready\n");
    expect(response.body.metrics).toHaveLength(2);
    expect(response.body.metrics[1]?.cpu).toBe(0.2);
  });
});
