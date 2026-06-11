import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the checkpoint get-by-id auth and not-found cases.
// Reading a real checkpoint needs a funded run that produced it
// (GAP-RUN-CREDITS), and the other-user / other-org 404 variants need a seeded
// foreign checkpoint; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-CHECKPOINTS-BY-ID-REJECTIONS).
const context = testContext();

const UNKNOWN_CHECKPOINT = "00000000-0000-4000-8000-000000000008";

describe("checkpoint get-by-id rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and 404s an unknown checkpoint", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.checkpointsById.getById({
        params: { id: UNKNOWN_CHECKPOINT },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.checkpointsById.getById({
        params: { id: UNKNOWN_CHECKPOINT },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // A valid session reading a checkpoint that does not exist.
    api.actAsAdmin();
    const notFound = await accept(
      api.checkpointsById.getById({
        params: { id: UNKNOWN_CHECKPOINT },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Checkpoint not found", code: "NOT_FOUND" },
    });
  });
});
