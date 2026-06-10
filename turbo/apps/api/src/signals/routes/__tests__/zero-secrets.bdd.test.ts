import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for user secrets. Preconditions and assertions are
// built from real HTTP requests (set → list → delete). The secret value is
// never returned by the API (only metadata), so encrypted-storage assertions
// stay out of scope here — the encryption path is still executed by `set`, and
// the crypto itself is a service-level exception (`crypto.utils.test.ts`).
// Connector-/other-user secrets can't be created through this API, so those
// filter cases are coverage-neutral drops. See `api.bdd.md` (CHAIN-SECRET).
const context = testContext();

describe("secrets (API-first BDD)", () => {
  it("chain-secret: creates, lists metadata, updates, sorts, then deletes secrets", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Then a new user has no secrets.
    const empty = await accept(
      api.secrets.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ secrets: [] });

    // When a secret is created. Then the response carries metadata only.
    const created = await accept(
      api.secrets.set({
        headers: SESSION_AUTH,
        body: { name: "Z_TOKEN", value: "secret-value", description: "token" },
      }),
      [200],
    );
    expect(created.body).toMatchObject({
      id: expect.any(String),
      name: "Z_TOKEN",
      description: "token",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(created.body).not.toHaveProperty("value");
    expect(created.body).not.toHaveProperty("encryptedValue");

    // When the same name is set again. Then it updates in place (no duplicate).
    await accept(
      api.secrets.set({
        headers: SESSION_AUTH,
        body: {
          name: "Z_TOKEN",
          value: "rotated-value",
          description: "rotated",
        },
      }),
      [200],
    );

    // When a second secret is created.
    await accept(
      api.secrets.set({
        headers: SESSION_AUTH,
        body: { name: "A_TOKEN", value: "alpha-value" },
      }),
      [200],
    );

    // Then the list returns both, sorted by name, never exposing the value.
    const listed = await accept(
      api.secrets.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      listed.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual(["A_TOKEN", "Z_TOKEN"]);
    expect(
      listed.body.secrets.find((secret) => {
        return secret.name === "Z_TOKEN";
      })?.description,
    ).toBe("rotated");
    for (const secret of listed.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }

    // When a secret is deleted. Then it disappears from the list.
    await accept(
      api.secretByName.delete({
        params: { name: "Z_TOKEN" },
        headers: SESSION_AUTH,
      }),
      [204],
    );
    const afterDelete = await accept(
      api.secrets.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(
      afterDelete.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual(["A_TOKEN"]);

    // When the same secret is deleted again. Then it is not found.
    await accept(
      api.secretByName.delete({
        params: { name: "Z_TOKEN" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });

  it("rejects invalid input and unauthenticated or no-org requests", async () => {
    const api = createBddApi(context);

    // Unauthenticated requests on every secrets route.
    await accept(api.secrets.list({ headers: {} }), [401]);
    await accept(
      api.secrets.set({ headers: {}, body: { name: "MY_SECRET", value: "v" } }),
      [401],
    );
    await accept(
      api.secretByName.delete({ params: { name: "MY_SECRET" }, headers: {} }),
      [401],
    );

    // A session without an active organization.
    api.actAsNoOrg();
    await accept(api.secrets.list({ headers: SESSION_AUTH }), [401]);

    // An invalid name and an empty value.
    api.actAsAdmin();
    const badName = await accept(
      api.secrets.set({
        headers: SESSION_AUTH,
        body: { name: "invalid name", value: "v" },
      }),
      [400],
    );
    expect(badName.body.error.code).toBe("BAD_REQUEST");
    const emptyValue = await accept(
      api.secrets.set({
        headers: SESSION_AUTH,
        body: { name: "MY_SECRET", value: "" },
      }),
      [400],
    );
    expect(emptyValue.body.error.code).toBe("BAD_REQUEST");
  });
});
