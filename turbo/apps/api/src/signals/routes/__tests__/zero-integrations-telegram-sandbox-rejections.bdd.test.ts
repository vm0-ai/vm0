import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";

// API-first BDD coverage for the sandbox-facing Telegram message + file-upload
// auth / capability / org-context rejections. A missing token is unauthorized, a
// zero token without telegram:write is forbidden, and a zero token whose org has
// no Clerk membership has no organization context. The success / unknown-bot
// (404) / Telegram-4xx (400) cases need a zero token whose org has a seeded bot
// reachable through a real membership (GAP-CONNECTOR-CONNECT), which the helper's
// internal random orgIds cannot align with, so they stay in the kept legacy. The
// upload-init endpoint keeps its 401 in legacy (its only reachable rejection;
// removing it would orphan the S3 presign mock priming). See `api.bdd.md`
// (CHAIN-TELEGRAM-SANDBOX-REJECTIONS).
const context = testContext();

describe("telegram sandbox message/upload rejections (API-first BDD)", () => {
  it("message rejects a missing token", async () => {
    const api = createBddApi(context);
    await accept(
      api.telegramMessage.sendMessage({
        body: { botId: "tg-bot", chatId: "-100", text: "hi" },
        headers: {},
      }),
      [401],
    );
  });

  it("upload complete rejects a missing capability and a zero token whose org has no membership", async () => {
    const api = createBddApi(context);
    const body = {
      uploadId: "00000000-0000-4000-8000-000000000004",
      botId: "tg-bot",
      chatId: "-1001234567890",
    };

    // A zero token without telegram:write is forbidden before any org lookup.
    const noCap = await accept(
      api.telegramUploadComplete.complete({ body, headers: api.zeroAuth([]) }),
      [403],
    );
    expect(noCap.body.error.message).toContain("telegram:write");

    // With the capability but no Clerk membership, there is no org context.
    api.mockOrgMemberships([]);
    const noOrg = await accept(
      api.telegramUploadComplete.complete({
        body,
        headers: api.zeroAuth(["telegram:write"]),
      }),
      [403],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Organization context is required", code: "FORBIDDEN" },
    });
  });
});
