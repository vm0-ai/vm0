import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import {
  draftPlainText,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();

function unloadPage(page: AbortController): void {
  const error = new Error("Page reloaded");
  error.name = "AbortError";
  page.abort(error);
  cleanup();
  // A real reload replaces the browser runtime too. Release setupPage's
  // history stubs before bootstrapping another Store in the same test window.
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

test.each([
  {
    target: "existing conversation",
    path: RUN_PATH,
    interruptHydration: false,
  },
  {
    target: "new conversation",
    path: NEW_CHAT_PATH,
    interruptHydration: false,
  },
  { target: "existing conversation", path: RUN_PATH, interruptHydration: true },
  { target: "new conversation", path: NEW_CHAT_PATH, interruptHydration: true },
])(
  "Preserve saved text and recovered voice while loading a $target draft (interrupted: $interruptHydration)",
  async ({ path, interruptHydration }) => {
    const initialPage = createChildAbortController(context.signal);
    const refreshedPage = createChildAbortController(refreshedContext.signal);
    const firstRequest = context.mocks.deferred<void>();
    const firstResponse = context.mocks.deferred<void>();
    const retryRequested = context.mocks.deferred<void>();
    const hydrationRequested = context.mocks.deferred<void>();
    const hydrationRestarted = context.mocks.deferred<void>();
    const hydrationReady = context.mocks.deferred<void>();
    let delayHydration = false;
    let hydrationRequests = 0;
    let transcriptionRequests = 0;
    let persistedDraft = textContinuityDraft("Keep these saved notes.");
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installRunChat();
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 60 });
    });
    const readDraft = async () => {
      if (delayHydration) {
        hydrationRequests += 1;
        if (hydrationRequests === 1) {
          hydrationRequested.resolve();
        } else if (hydrationRequests === 2) {
          hydrationRestarted.resolve();
        }
        await hydrationReady.promise;
      }
      return persistedDraft;
    };
    context.mocks.api(agentDraftContract.get, async ({ respond }) => {
      return respond(200, await readDraft());
    });
    context.mocks.api(chatThreadDraftContract.get, async ({ respond }) => {
      return respond(200, await readDraft());
    });
    context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
      persistedDraft = {
        draftUserMessage: body.draftUserMessage,
        draftAttachments: body.draftAttachments ?? null,
      };
      return respond(204);
    });
    context.mocks.api(chatThreadByIdContract.patch, ({ body, respond }) => {
      if (body.draftUserMessage !== undefined) {
        persistedDraft = {
          draftUserMessage: body.draftUserMessage,
          draftAttachments: body.draftAttachments ?? null,
        };
      }
      return respond(204);
    });
    context.mocks.http.post("*/api/voice-io/transcribe/segment", async () => {
      transcriptionRequests += 1;
      if (transcriptionRequests === 2) {
        retryRequested.resolve();
      }
      if (transcriptionRequests === 1) {
        firstRequest.resolve();
        await firstResponse.promise;
      }
      return HttpResponse.json({
        transcript: "recovered voice note",
        polishedText: "Recovered voice note.",
        language: "en-US",
      });
    });

    await setupPage({
      context: {
        ...context,
        signal: initialPage.signal,
      },
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent("Keep these saved notes.");
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await firstRequest.promise;
    unloadPage(initialPage);
    firstResponse.resolve();

    delayHydration = true;
    await setupPage({
      context: {
        ...refreshedContext,
        signal: refreshedPage.signal,
      },
      path,
      featureSwitches: { [FeatureSwitchKey.VoiceInputV2]: true },
    });
    await hydrationRequested.promise;
    click(await findEnabledButton("Retry"));
    await retryRequested.promise;
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing...");
    if (interruptHydration) {
      click(await findLink("Agents"));
      await screen.findByRole("heading", { name: "Agents" });
      window.history.back();
      await hydrationRestarted.promise;
      click(await findEnabledButton("Retry"));
    }
    hydrationReady.resolve();
    delayHydration = false;
    await findEnabledButton("Send");
    await waitFor(() => {
      const savedText = draftPlainText(persistedDraft.draftUserMessage);
      expect(savedText).toContain("Keep these saved notes.");
      expect(savedText).toContain("Recovered voice note.");
    });
    expect(hydrationRequests).toBe(interruptHydration ? 2 : 1);
    // The successful retry is checkpointed before waiting for text hydration.
    expect(transcriptionRequests).toBe(2);

    // Assert the recovered composer and persisted text at the handoff boundary.
    // Ordinary saved-draft restoration is covered in chat-continuity-drafts.
    await findEnabledButton("Voice input");
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(composer).toHaveTextContent("Keep these saved notes.");
    expect(composer).toHaveTextContent("Recovered voice note.");
    expect(queryButton("Retry")).toBeNull();
  },
);
