import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the CLI compose create auth case plus a full
// create-then-read lifecycle. The name-normalization, field-stripping,
// update-by-name, version-reuse, agent-name / framework validation 400s and
// sandbox-token variants need seeded composes or structured invalid content, so
// they stay in the kept legacy. See `api.bdd.md`
// (CHAIN-AGENT-COMPOSES-CREATE-REJECTIONS).
const context = testContext();

function composeContent(name: string) {
  return {
    version: "1.0",
    agents: { [name]: { framework: "claude-code" as const } },
  };
}

describe("agent compose create rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers", async () => {
    const api = createBddApi(context);
    await accept(
      api.agentComposesMain.create({
        body: { content: composeContent("unauth-agent") },
        headers: {},
      }),
      [401],
    );
  });

  it("creates a compose for an admin and the compose is then readable by name", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();
    // A unique name so the create is genuinely new (compose content is hashed
    // into the version id; a fixed name would resolve to a pre-existing version).
    const name = `bdd-create-${randomUUID().slice(0, 8)}`;

    // When the admin creates a compose,
    const created = await accept(
      api.agentComposesMain.create({
        body: { content: composeContent(name) },
        headers: SESSION_AUTH,
      }),
      [201],
    );
    expect(created.body).toMatchObject({ name, action: "created" });
    expect(created.body.composeId).toStrictEqual(expect.any(String));

    // Then it can be fetched back by name.
    const fetched = await accept(
      api.agentComposesMain.getByName({
        query: { name },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(fetched.body.name).toBe(name);
  });
});
