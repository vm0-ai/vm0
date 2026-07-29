import { createStore } from "ccstate";
import { describe, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { seedOwnedConnectorSecret } from "./helpers/connector-credential-storage-state";
import {
  deleteUsageInsightFixture$,
  insertUsageEvent$,
  materializeHourlyUsage$,
  readUsageStorageCounts$,
  seedUsageInsightFixture$,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

describe("usage insight test state", () => {
  it("cascades connector credentials when deleting fixture connectors", async () => {
    const fixture = await store.set(
      seedUsageInsightFixture$,
      undefined,
      context.signal,
    );
    await seedOwnedConnectorSecret(context, {
      ...fixture,
      connectorSlug: "fixture-connector",
      authMethod: "api-token",
      storageVersion: 1,
      name: "FIXTURE_CONNECTOR_TOKEN",
      encryptedValue: "fixture-value",
      description: null,
    });

    await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("moves processed fixture usage to hourly storage", async () => {
    const fixture = await store.set(
      seedUsageInsightFixture$,
      undefined,
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId: null,
        status: "processed",
        creditsCharged: 10,
        processedAt: new Date("2026-07-28T10:45:00.000Z"),
      },
      context.signal,
    );

    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 1, hourly: 0 });
    await expect(
      store.set(
        materializeHourlyUsage$,
        { ...fixture, runId: null },
        context.signal,
      ),
    ).resolves.toBe(1);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 1 });

    await store.set(deleteUsageInsightFixture$, fixture, context.signal);
    await expect(
      store.set(
        readUsageStorageCounts$,
        { scope: "organization", id: fixture.orgId },
        context.signal,
      ),
    ).resolves.toStrictEqual({ raw: 0, hourly: 0 });
  });
});
