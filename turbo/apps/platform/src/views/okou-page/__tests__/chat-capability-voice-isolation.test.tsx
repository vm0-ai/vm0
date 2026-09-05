import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
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
  const errorSpy = vi.spyOn(console, "error");
  const original = errorSpy.getMockImplementation();
  if (!original) {
    throw new Error("Expected console guard");
  }
  const errors: unknown[][] = [];
  errorSpy.mockImplementation((...args: unknown[]) => {
    if (
      args[0] === "[E][Composer:VoiceDraft]" &&
      args[1] === "Voice draft transcription failed"
    ) {
      errors.push(args);
      return;
    }
    original(...args);
  });
  return errors;
}

test.each(["user", "org", "target"] as const)(
  "Keep local recordings isolated when the composer changes %s",
  async (part) => {
    const consoleErrors = installVoiceBoundaries();
    const firstPage = createChildAbortController(context.signal);
    const secondPage = createChildAbortController(secondContext.signal);
    let successful = false;
    context.mocks.http.post("*/api/voice-io/transcribe", () => {
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
    expect(consoleErrors).toHaveLength(2);
    for (const error of consoleErrors) {
      expect(error).toStrictEqual([
        "[E][Composer:VoiceDraft]",
        "Voice draft transcription failed",
        expect.objectContaining({ status: 503, code: "UNKNOWN" }),
      ]);
    }
  },
);

test("Two open composers preserve an unfinished recording and stale Remove cannot delete its replacement", async () => {
  const consoleErrors = installVoiceBoundaries();
  let successful = false;
  let transcript = "First recording.";
  const uploads: ArrayBuffer[] = [];
  context.mocks.http.post("*/api/voice-io/transcribe", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Expected recorded audio");
    }
    uploads.push(await file.arrayBuffer());
    return successful
      ? HttpResponse.json({
          transcript,
          polishedText: transcript,
          language: "en-US",
        })
      : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
  });
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  const firstComposer = await screen.findByRole("textbox", { name: "Message" });
  const firstRoot = Array.from(document.body.children).find((element) => {
    return element.contains(firstComposer);
  })!;
  await findEnabledButton("Voice input", firstRoot);
  restoreHistory();
  await setupPage({
    context: secondContext,
    path: RUN_PATH,
    featureSwitches: flags,
  });
  const secondRoot = await waitFor(() => {
    const root = Array.from(document.body.children).find((element) => {
      return (
        element !== firstRoot &&
        within(element as HTMLElement).queryByRole("textbox", {
          name: "Message",
        })
      );
    });
    expect(root).toBeDefined();
    return root!;
  });
  await findEnabledButton("Voice input", secondRoot);
  click(await findEnabledButton("Voice input", firstRoot));
  click(await findEnabledButton("Stop recording", firstRoot));
  await findEnabledButton("Retry", firstRoot);
  // This composer was already idle before the other tab created its recording.
  click(await findEnabledButton("Voice input", secondRoot));
  await findEnabledButton("Retry", secondRoot);
  expect(queryButton("Stop recording", secondRoot)).toBeNull();
  successful = true;
  click(await findEnabledButton("Retry", secondRoot));
  await findEnabledButton("Voice input", secondRoot);
  expect(
    within(secondRoot as HTMLElement).getByRole("textbox", { name: "Message" }),
  ).toHaveTextContent("First recording.");
  expect(uploads[1]).toStrictEqual(uploads[0]);
  successful = false;
  transcript = "Replacement recording.";
  context.mocks.browser.voiceInput({
    rms: 0.12,
    finalPcmSamples: new Float32Array(4096).fill(-0.5),
  });
  click(await findEnabledButton("Voice input", secondRoot));
  click(await findEnabledButton("Stop recording", secondRoot));
  await findEnabledButton("Retry", secondRoot);
  // The first composer still holds the old identity. Its cleanup must be a no-op.
  click(await findEnabledButton("Remove voice draft", firstRoot));
  await findEnabledButton("Retry", firstRoot);
  successful = true;
  click(await findEnabledButton("Retry", secondRoot));
  await findEnabledButton("Voice input", secondRoot);
  expect(
    within(secondRoot as HTMLElement).getByRole("textbox", { name: "Message" }),
  ).toHaveTextContent("Replacement recording.");
  const recovered = decodeVoiceDraftPcmWav(uploads.at(-1)!);
  expect(recovered?.at(-1)).toBeCloseTo(-0.5, 4);
  expect(consoleErrors).toHaveLength(2);
  for (const error of consoleErrors) {
    expect(error).toStrictEqual([
      "[E][Composer:VoiceDraft]",
      "Voice draft transcription failed",
      expect.objectContaining({ status: 503, code: "UNKNOWN" }),
    ]);
  }
});
