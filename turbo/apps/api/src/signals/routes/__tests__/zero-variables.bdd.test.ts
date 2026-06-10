import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for user variables. Preconditions and assertions are
// built entirely from real HTTP requests (set → list → delete). See
// `api.bdd.md` (CHAIN-VARIABLE). Connector-owned variables cannot be created
// through this API, so those filter cases stay in the legacy files
// (GAP-CONNECTOR-VARIABLE).
const context = testContext();

describe("variables (API-first BDD)", () => {
  it("chain-variable: creates, lists, updates, sorts, then deletes variables", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a new user has no variables.
    const empty = await accept(
      api.variables.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ variables: [] });

    // When a variable is created. Then the response describes it.
    const created = await accept(
      api.variables.set({
        headers: SESSION_AUTH,
        body: { name: "Z_REGION", value: "us-west-2", description: "region" },
      }),
      [200],
    );
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: "Z_REGION",
      value: "us-west-2",
      description: "region",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    // When the same name is set again. Then it updates in place (no duplicate).
    const updated = await accept(
      api.variables.set({
        headers: SESSION_AUTH,
        body: { name: "Z_REGION", value: "us-east-1", description: "updated" },
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      name: "Z_REGION",
      value: "us-east-1",
      description: "updated",
    });

    // When a second variable is created.
    await accept(
      api.variables.set({
        headers: SESSION_AUTH,
        body: { name: "A_ENDPOINT", value: "https://api.example.test" },
      }),
      [200],
    );

    // Then the list returns both, sorted by name, with the latest value.
    const listed = await accept(
      api.variables.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual(["A_ENDPOINT", "Z_REGION"]);
    expect(
      listed.body.variables.find((variable) => {
        return variable.name === "Z_REGION";
      })?.value,
    ).toBe("us-east-1");

    // When a variable is deleted. Then it disappears from the list.
    await accept(
      api.variableByName.delete({
        params: { name: "Z_REGION" },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.variables.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      afterDelete.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual(["A_ENDPOINT"]);

    // When the same variable is deleted again. Then it is not found.
    const missing = await accept(
      api.variableByName.delete({
        params: { name: "Z_REGION" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(missing.body.error.message).toBe('Variable "Z_REGION" not found');
  });

  it("rejects invalid names and unauthenticated or no-org requests", async () => {
    const api = createBddApi(context);

    // Unauthenticated requests on every variables route.
    await accept(api.variables.list({ headers: {} }), [401]);
    await accept(
      api.variables.set({
        headers: {},
        body: { name: "MY_VAR", value: "v" },
      }),
      [401],
    );
    await accept(
      api.variableByName.delete({ params: { name: "MY_VAR" }, headers: {} }),
      [401],
    );

    // A session without an active organization.
    api.actAsNoOrg();
    await accept(api.variables.list({ headers: SESSION_AUTH }), [401]);

    // An invalid variable name.
    api.actAsAdmin();
    const bad = await accept(
      api.variables.set({
        headers: SESSION_AUTH,
        body: { name: "invalid name with spaces", value: "v" },
      }),
      [400],
    );
    expect(bad.body.error.code).toBe("BAD_REQUEST");
  });
});
