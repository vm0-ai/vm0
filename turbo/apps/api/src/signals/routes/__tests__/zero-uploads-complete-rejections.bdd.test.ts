import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the upload-complete rejections: auth, capability,
// and body/content-type validation. The recording/association success paths and
// the not-found object case need a prepared upload + S3 object + run/chat-thread
// state with no API surface (GAP-UPLOAD-COMPLETE) and stay in the kept legacy.
// See `api.bdd.md` (CHAIN-UPLOADS-COMPLETE-REJECTIONS).
const context = testContext();

describe("upload complete rejections (API-first BDD)", () => {
  it("rejects unauthenticated and capability-less callers", async () => {
    const api = createBddApi(context);

    const unauth = await accept(
      api.uploads.complete({ headers: {}, body: { id: randomUUID() } }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // A zero token without file:write cannot complete an upload.
    const zero = await accept(
      api.uploads.complete({
        headers: api.zeroAuth([]),
        body: { id: randomUUID() },
      }),
      [403],
    );
    expect(zero.body.error.message).toContain("file:write");
  });

  it("validates the body id and content type", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // A non-uuid id is rejected by request validation.
    const badId = await accept(
      api.uploads.complete({
        headers: SESSION_AUTH,
        body: { id: "not-a-uuid" } as never,
      }),
      [400],
    );
    expect(badId.body.error.code).toBe("BAD_REQUEST");

    // An unsupported content type is rejected.
    const unsupported = await accept(
      api.uploads.complete({
        headers: SESSION_AUTH,
        body: { id: randomUUID(), contentType: "application/x-msdownload" },
      }),
      [400],
    );
    expect(unsupported.body.error.message).toBe(
      "Unsupported file type: application/x-msdownload",
    );
  });
});
