import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const secondContext = testContext();
const thirdContext = testContext();
const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;

function restoreHistory() {
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function unload(page: AbortController) {
  const error = new Error("Page reloaded");
  error.name = "AbortError";
  page.abort(error);
  cleanup();
  restoreHistory();
}

function installVoiceBoundaries() {
  installRunChat();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
}

test.each(["user", "org", "target"] as const)(
  "Keep local recordings isolated when the composer changes %s",
  async (part) => {
    installVoiceBoundaries();
    const firstPage = createChildAbortController(context.signal);
    const secondPage = createChildAbortController(secondContext.signal);
    let successful = false;
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      return successful
        ? HttpResponse.json({
            transcript: "original",
            polishedText: "Original recording.",
            language: "en-US",
          })
        : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
    });
    await setupPage({
      context: { ...context, signal: firstPage.signal },
      path: RUN_PATH,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    unload(firstPage);
    await setupPage({
      context: { ...secondContext, signal: secondPage.signal },
      path: part === "target" ? NEW_CHAT_PATH : RUN_PATH,
      featureSwitches: flags,
      auth: {
        user: {
          id: part === "user" ? "other-user" : "test-user-123",
          fullName: "Test User",
        },
        ...(part === "org"
          ? {
              organization: {
                activeOrg: { id: "org_other", name: "Other Organization" },
                memberships: [{ id: "org_other" }],
              },
            }
          : {}),
      },
    });
    await findEnabledButton("Voice input");
    expect(queryButton("Retry")).toBeNull();
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    click(await findEnabledButton("Remove voice draft"));
    await findEnabledButton("Voice input");
    unload(secondPage);
    successful = true;
    await setupPage({
      context: thirdContext,
      path: RUN_PATH,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Original recording.",
    );
  },
);
