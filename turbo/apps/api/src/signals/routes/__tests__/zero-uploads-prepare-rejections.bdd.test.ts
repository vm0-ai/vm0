import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the upload-prepare rejections: auth, capability,
// and body/size/content-type validation. The presigned-URL success path needs
// S3 plus a seeded org tier (the suspended-credits guard) — kept in the legacy
// (GAP-UPLOAD-PRESIGN). See `api.bdd.md` (CHAIN-UPLOADS-PREPARE-REJECTIONS).
const context = testContext();

function validBody() {
  return {
    filename: "report.pdf",
    contentType: "application/pdf",
    size: 1024,
  };
}

describe("upload prepare rejections (API-first BDD)", () => {
  it("rejects unauthenticated and capability-less callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.uploads.prepare({ headers: {}, body: validBody() }),
      [401],
    );

    // A zero token without file:write cannot prepare an upload.
    const zero = await accept(
      api.uploads.prepare({ headers: api.zeroAuth([]), body: validBody() }),
      [403],
    );
    expect(zero.body.error.message).toContain("file:write");
  });

  it("validates the body, size, and content type", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // A malformed body (empty filename) is rejected.
    await accept(
      api.uploads.prepare({
        headers: SESSION_AUTH,
        body: { filename: "" } as never,
      }),
      [400],
    );

    // A file larger than 1 GB is rejected.
    const tooLarge = await accept(
      api.uploads.prepare({
        headers: SESSION_AUTH,
        body: {
          filename: "big.bin",
          contentType: "application/pdf",
          size: 1024 * 1024 * 1024 + 1,
        },
      }),
      [400],
    );
    expect(tooLarge.body.error.message).toContain("File too large");

    // An unsupported content type is rejected.
    const unsupported = await accept(
      api.uploads.prepare({
        headers: SESSION_AUTH,
        body: {
          filename: "bad.exe",
          contentType: "application/x-msdownload",
          size: 10,
        },
      }),
      [400],
    );
    expect(unsupported.body.error.message).toContain("Unsupported file type");
  });
});
