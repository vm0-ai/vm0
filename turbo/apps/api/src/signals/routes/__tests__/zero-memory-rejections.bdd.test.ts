import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the user memory-artifact get auth and no-artifact
// cases. A populated / empty-but-present memory artifact needs a seeded memory
// volume and stays in the kept legacy. See `api.bdd.md`
// (CHAIN-MEMORY-REJECTIONS).
const context = testContext();

describe("zero memory rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and reports exists:false for a fresh user", async () => {
    const api = createBddApi(context);

    await accept(api.memory.get({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.memory.get({ headers: SESSION_AUTH }), [401]);

    // A fresh user has no memory artifact.
    api.actAsAdmin();
    const empty = await accept(
      api.memory.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.exists).toBeFalsy();
    expect(empty.body.size).toBe(0);
    expect(empty.body.fileCount).toBe(0);
    expect(empty.body.updatedAt).toBeNull();
    expect(empty.body.files).toStrictEqual([]);
    expect(empty.body.fileContents).toStrictEqual([]);
  });
});
