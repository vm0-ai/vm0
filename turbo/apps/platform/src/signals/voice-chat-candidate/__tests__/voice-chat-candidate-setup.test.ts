import { describe, expect, it } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { setupVoiceChatCandidatePage$ } from "../voice-chat-candidate-setup.ts";
import { vccStatus$ } from "../voice-chat-candidate-session.ts";

const context = testContext();

async function setup() {
  await setupPage({
    context,
    path: "/voice-chat-candidate",
    withoutRender: true,
  });
}

describe("setupVoiceChatCandidatePage$", () => {
  it("completes without throwing and leaves status idle", async () => {
    await setup();

    await context.store.set(setupVoiceChatCandidatePage$, context.signal);

    expect(context.store.get(vccStatus$)).toBe("idle");
  });
});
