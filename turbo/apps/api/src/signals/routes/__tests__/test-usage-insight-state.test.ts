import { createStore } from "ccstate";
import { describe, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { seedOwnedConnectorSecret } from "./helpers/connector-credential-storage-state";
import {
  deleteUsageInsightFixture$,
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
      connectorRef: "fixture-connector",
      authMethod: "api-token",
      storageVersion: 1,
      name: "FIXTURE_CONNECTOR_TOKEN",
      encryptedValue: "fixture-value",
      description: null,
    });

    await store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });
});
