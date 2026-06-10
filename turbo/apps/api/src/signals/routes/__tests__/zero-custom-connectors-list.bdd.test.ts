import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for GET /api/zero/custom-connectors. The connector and
// its per-user secret are both built through real API requests (create +
// secret set), so the list's hasSecret false/true branches are covered without
// DB seeding. See `api.bdd.md` (CHAIN-CUSTOM-CONNECTOR-LIST).
const context = testContext();

describe("custom connectors list (API-first BDD)", () => {
  it("lists org connectors and reflects per-user secret state", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a new org has no custom connectors.
    const empty = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ connectors: [] });

    // When a connector is created. Then it is listed with hasSecret: false.
    const created = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: {
          displayName: "Example",
          prefixes: ["https://api.example.com/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
        },
      }),
      [201],
    );
    const connectorId = created.body.id;
    const beforeSecret = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(beforeSecret.body.connectors).toStrictEqual([
      {
        id: connectorId,
        slug: created.body.slug,
        displayName: "Example",
        prefixes: ["https://api.example.com/"],
        headerName: "Authorization",
        headerTemplate: "Bearer {{secret}}",
        createdAt: created.body.createdAt,
        updatedAt: created.body.updatedAt,
        hasSecret: false,
      },
    ]);

    // When the user sets a secret. Then the list reflects hasSecret: true.
    await accept(
      api.customConnectorSecret.set({
        params: { id: connectorId },
        headers: SESSION_AUTH,
        body: { value: "sk_live_xyz" },
      }),
      [200, 204],
    );
    const afterSecret = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(afterSecret.body.connectors).toHaveLength(1);
    expect(afterSecret.body.connectors[0]?.hasSecret).toBeTruthy();
  });

  it("rejects unauthenticated and no-organization list requests", async () => {
    const api = createBddApi(context);

    const unauth = await accept(
      api.customConnectors.list({ headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    api.actAsNoOrg();
    const noOrg = await accept(
      api.customConnectors.list({ headers: SESSION_AUTH }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");
  });
});
