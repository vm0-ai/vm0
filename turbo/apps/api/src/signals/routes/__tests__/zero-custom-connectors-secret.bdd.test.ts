import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for per-user custom-connector secrets (set + delete).
// The secret value is never returned by the API; only `hasSecret` is observable
// via list. The decrypt round-trip assertion is out of scope (crypto is a
// service-level exception). See `api.bdd.md` (CHAIN-CUSTOM-CONNECTOR-SECRET).
const context = testContext();

function connectorBody() {
  return {
    displayName: "Example",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

describe("custom connector secrets (API-first BDD)", () => {
  it("chain-custom-connector-secret: sets, reflects, then clears a secret", async () => {
    const api = createBddApi(context);
    const orgId = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId });

    // Given a connector (created by an admin).
    const created = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody(),
      }),
      [201],
    );
    const connectorId = created.body.id;

    // When a non-admin member sets their own secret. Then list shows hasSecret.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await accept(
      api.customConnectorSecret.set({
        params: { id: connectorId },
        headers: SESSION_AUTH,
        body: { value: "sk_live_member" },
      }),
      [200, 204],
    );
    const withSecret = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(withSecret.body.connectors[0]?.hasSecret).toBeTruthy();

    // When the member clears their secret. Then hasSecret is false again.
    await accept(
      api.customConnectorSecret.delete({
        params: { id: connectorId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const cleared = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(cleared.body.connectors[0]?.hasSecret).toBeFalsy();

    // When the secret is cleared again. Then it is idempotent (204).
    await accept(
      api.customConnectorSecret.delete({
        params: { id: connectorId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
  });

  it("rejects unknown connectors, unauthenticated, and no-organization secret ops", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    // Unauthenticated.
    await accept(
      api.customConnectorSecret.set({
        params: { id },
        headers: {},
        body: { value: "x" },
      }),
      [401],
    );
    await accept(
      api.customConnectorSecret.delete({ params: { id }, headers: {} }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.customConnectorSecret.set({
        params: { id },
        headers: SESSION_AUTH,
        body: { value: "x" },
      }),
      [401],
    );

    // Setting a secret on an unknown connector is not found.
    api.actAsAdmin();
    await accept(
      api.customConnectorSecret.set({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
        body: { value: "x" },
      }),
      [404],
    );
  });
});
