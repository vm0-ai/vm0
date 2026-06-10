import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for custom-connector create / patch / delete. All are
// admin-gated and fully reachable through the API. See `api.bdd.md`
// (CHAIN-CUSTOM-CONNECTOR).
const context = testContext();

function connectorBody(host: string) {
  return {
    displayName: "Example",
    prefixes: [`https://${host}/v1`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

describe("custom connectors CRUD (API-first BDD)", () => {
  it("chain-custom-connector: creates, renames, then deletes a connector", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // When an admin creates a connector. Then the prefix is normalised and a
    // slug is derived.
    const created = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("api.example.com"),
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      displayName: "Example",
      prefixes: ["https://api.example.com/v1/"],
      hasSecret: false,
    });
    expect(created.body.slug).toMatch(/^api-example-com-/);
    const connectorId = created.body.id;

    // Then it appears in the list.
    const listed = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.connectors.map((connector) => {
        return connector.id;
      }),
    ).toStrictEqual([connectorId]);

    // When it is renamed. Then the list reflects the new name.
    await accept(
      api.customConnectorById.patch({
        params: { id: connectorId },
        headers: SESSION_AUTH,
        body: { displayName: "Renamed" },
      }),
      [200],
    );
    const afterRename = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterRename.body.connectors[0]?.displayName).toBe("Renamed");

    // Given the user has set a secret on the connector.
    await accept(
      api.customConnectorSecret.set({
        params: { id: connectorId },
        headers: SESSION_AUTH,
        body: { value: "sk_live_xyz" },
      }),
      [200, 204],
    );

    // When it is deleted. Then the row and its secrets are removed.
    await accept(
      api.customConnectorById.delete({
        params: { id: connectorId },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterDelete.body).toStrictEqual({ connectors: [] });
  });

  it("normalises a host-wildcard prefix and validates the create body", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // A host-wildcard prefix is accepted and normalised.
    const wildcard = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("*.example.com"),
      }),
      [201],
    );
    expect(wildcard.body.prefixes).toStrictEqual(["https://*.example.com/v1/"]);
    expect(wildcard.body.slug).toMatch(/^example-com-/);

    // A prefix that already ends with a slash is stored unchanged.
    const trailing = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: {
          ...connectorBody("api.example.com"),
          prefixes: ["https://api.example.com/"],
        },
      }),
      [201],
    );
    expect(trailing.body.prefixes).toStrictEqual(["https://api.example.com/"]);

    // A header template missing the {{secret}} placeholder is rejected.
    const noPlaceholder = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: {
          ...connectorBody("api.example.com"),
          headerTemplate: "Bearer static-token",
        },
      }),
      [400],
    );
    expect(noPlaceholder.body.error.code).toBe("BAD_REQUEST");

    // A non-https prefix is rejected.
    const nonHttps = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: {
          ...connectorBody("api.example.com"),
          prefixes: ["http://api.example.com/"],
        },
      }),
      [400],
    );
    expect(nonHttps.body.error.code).toBe("BAD_REQUEST");
  });

  it("enforces admin-only access and rejects unknown / cross-org / unauthenticated", async () => {
    const api = createBddApi(context);
    const id = randomUUID();

    // Unauthenticated requests on every route.
    await accept(
      api.customConnectors.create({
        headers: {},
        body: connectorBody("api.example.com"),
      }),
      [401],
    );
    await accept(
      api.customConnectorById.patch({
        params: { id },
        headers: {},
        body: { displayName: "x" },
      }),
      [401],
    );
    await accept(
      api.customConnectorById.delete({ params: { id }, headers: {} }),
      [401],
    );

    // A non-admin member may not create / patch / delete.
    const orgId = `org_${randomUUID()}`;
    api.actAsAdmin({ orgId });
    const created = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("api.example.com"),
      }),
      [201],
    );
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("api.example.com"),
      }),
      [403],
    );
    await accept(
      api.customConnectorById.patch({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
        body: { displayName: "Nope" },
      }),
      [403],
    );
    await accept(
      api.customConnectorById.delete({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
      }),
      [403],
    );

    // An admin sees 404 for unknown ids, cross-org ids, and an empty rename.
    api.actAsAdmin();
    await accept(
      api.customConnectorById.patch({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
        body: { displayName: "x" },
      }),
      [404],
    );
    await accept(
      api.customConnectorById.delete({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    await accept(
      api.customConnectorById.patch({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
        body: { displayName: "x" },
      }),
      [404],
    );
    await accept(
      api.customConnectorById.delete({
        params: { id: created.body.id },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    const emptyName = await accept(
      api.customConnectorById.patch({
        params: { id: randomUUID() },
        headers: SESSION_AUTH,
        body: { displayName: "" },
      }),
      [400],
    );
    expect(emptyName.body.error.code).toBe("BAD_REQUEST");
  });
});
