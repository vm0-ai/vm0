import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { chatThreadDraftContract } from "@okouai/api-contracts/contracts/chat-threads";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createChildAbortController } from "../../../signals/utils.ts";
import { decodeVoiceDraftPcmWav } from "../../../signals/voice-io/voice-draft-pcm.ts";
import {
  completedConversation,
  context,
  installCapabilityChat,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  findEnabledButton,
  NEW_CHAT_PATH,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const refreshedContext = testContext();
const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;
const targets = [
  { target: "agent", name: "Zero", path: NEW_CHAT_PATH },
  { target: "thread", name: "Capability conversation", path: RUN_PATH },
] as const;

interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: { id: string; sampleCount: number; chunkCount: number };
  };
}

async function recordings() {
  const db = await openDB<RecordingDatabase>("okou-voice-drafts", 1);
  const saved = await db.getAll("drafts");
  db.close();
  return saved;
}

function unload(page: AbortController) {
  const aborted = new Error("Page reloaded");
  aborted.name = "AbortError";
  page.abort(aborted);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function installVoiceBoundaries() {
  installCapabilityChat({
    events: completedConversation("The launch plan has three careful stages."),
  });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft("Keep the existing notes."));
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft("Keep the existing notes."));
  });
}

async function openForwardComposer(name: string) {
  await selectPassage("launch plan has three careful stages");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByRole("option", { name }));
  return dialog;
}

async function uploadedAudio(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected recorded audio");
  }
  return await file.arrayBuffer();
}

test.each(
  targets.flatMap((target) => {
    return ["recording", "transcribing", "failed"].map((interruption) => {
      return { ...target, interruption };
    });
  }),
)(
  "Recover a forwarded $target recording after reloading while $interruption",
  async ({ name, path, interruption }) => {
    const initialPage = createChildAbortController(context.signal);
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    const firstRequest = context.mocks.deferred<void>();
    const firstResponse = context.mocks.deferred<void>();
    const retryRequest = context.mocks.deferred<void>();
    const retryResponse = context.mocks.deferred<void>();
    installVoiceBoundaries();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
      finalPcmSamples: new Float32Array(1024).fill(-0.75),
    });
    const uploads: ArrayBuffer[] = [];
    let successful = false;
    context.mocks.http.post(
      "*/api/voice-io/transcribe",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        if (uploads.length === 1) {
          firstRequest.resolve();
          if (interruption === "transcribing") {
            await firstResponse.promise;
          }
        }
        if (uploads.length === (interruption === "recording" ? 1 : 2)) {
          retryRequest.resolve();
          await retryResponse.promise;
        }
        return successful
          ? HttpResponse.json({
              transcript: "recovered",
              polishedText: "Recovered forwarded audio.",
              language: "en-US",
            })
          : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
      },
    );
    await setupPage({
      context: { ...context, signal: initialPage.signal },
      path: RUN_PATH,
      featureSwitches: flags,
    });
    await findEnabledButton("Voice input");
    const dialog = await openForwardComposer(name);
    click(await findEnabledButton("Voice input", dialog));
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    await waitFor(async () => {
      await expect(recordings()).resolves.toMatchObject([
        { sampleCount: 4096, chunkCount: 1 },
      ]);
    });
    if (interruption !== "recording") {
      click(await findEnabledButton("Stop recording", dialog));
      await firstRequest.promise;
      if (interruption === "failed") {
        await findEnabledButton("Retry", dialog);
      }
    }
    const saved = await recordings();
    unload(initialPage);
    firstResponse.resolve();
    await setupPage({
      context: refreshedContext,
      path,
      featureSwitches: flags,
    });
    await findEnabledButton("Retry");
    await expect(recordings()).resolves.toStrictEqual(saved);
    expect(queryButton("Stop recording")).toBeNull();
    click(await findEnabledButton("Retry"));
    await retryRequest.promise;
    await screen.findByText("Transcribing...");
    retryResponse.resolve();
    await findEnabledButton("Retry");
    await expect(recordings()).resolves.toStrictEqual(saved);
    successful = true;
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep the existing notes.Recovered forwarded audio.",
    );
    expect(uploads).toHaveLength(interruption === "recording" ? 2 : 3);
    for (const upload of uploads) {
      expect(upload).toStrictEqual(uploads[0]);
    }
    const samples = decodeVoiceDraftPcmWav(uploads[0]!);
    expect(samples).toHaveLength(interruption === "recording" ? 4096 : 5120);
    expect(samples?.at(-1)).toBeCloseTo(
      interruption === "recording" ? 0.25 : -0.75,
      4,
    );
    await expect(recordings()).resolves.toStrictEqual([]);
  },
);

test.each(targets)(
  "Stop a forwarded $target microphone when its dialog closes and recover saved audio",
  async ({ name, path }) => {
    const initialPage = createChildAbortController(context.signal);
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    const stopped = context.mocks.deferred<void>();
    installVoiceBoundaries();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
      onTrackStop: () => {
        if (!stopped.settled()) {
          stopped.resolve();
        }
      },
    });
    const uploads: ArrayBuffer[] = [];
    context.mocks.http.post(
      "*/api/voice-io/transcribe",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        return HttpResponse.json({
          transcript: "recovered",
          polishedText: "Recovered forwarded audio.",
          language: "en-US",
        });
      },
    );
    await setupPage({
      context: { ...context, signal: initialPage.signal },
      path: RUN_PATH,
      featureSwitches: flags,
    });
    await findEnabledButton("Voice input");
    const dialog = await openForwardComposer(name);
    click(await findEnabledButton("Voice input", dialog));
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    await waitFor(async () => {
      await expect(recordings()).resolves.toMatchObject([
        { sampleCount: 4096 },
      ]);
    });
    click(await findEnabledButton("Close", dialog));
    await stopped.promise;
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(uploads).toStrictEqual([]);
    unload(initialPage);
    await setupPage({
      context: refreshedContext,
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Recovered forwarded audio.",
    );
    expect(uploads).toHaveLength(1);
    expect(decodeVoiceDraftPcmWav(uploads[0]!)).toHaveLength(4096);
    await expect(recordings()).resolves.toStrictEqual([]);
  },
);

test.each(targets)(
  "Release a forwarded $target audio context when its dialog closes during startup",
  async ({ name }) => {
    installVoiceBoundaries();
    const moduleRequested = context.mocks.deferred<void>();
    const moduleReady = context.mocks.deferred<void>();
    const contextClosed = context.mocks.deferred<void>();
    const trackStopped = context.mocks.deferred<void>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      pcmWorkletReady: () => {
        moduleRequested.resolve();
        return moduleReady.promise;
      },
      onAudioContextClose: contextClosed.resolve,
      onTrackStop: trackStopped.resolve,
    });
    await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
    await findEnabledButton("Voice input");
    const dialog = await openForwardComposer(name);
    click(await findEnabledButton("Voice input", dialog));
    await moduleRequested.promise;
    expect(queryButton("Starting voice input", dialog)).toBeDisabled();
    click(await findEnabledButton("Close", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    moduleReady.resolve();
    await Promise.all([contextClosed.promise, trackStopped.promise]);
    await findEnabledButton("Voice input");
    expect(
      screen.queryByText("Voice transcription failed. Try again."),
    ).not.toBeInTheDocument();
  },
);

test.each(targets)(
  "Reuse an unfinished $target recording in the forward dialog without replacing it",
  async ({ name, path }) => {
    const initialPage = createChildAbortController(context.signal);
    installVoiceBoundaries();
    context.mocks.browser.voiceInput({ rms: 0.12 });
    const uploads: ArrayBuffer[] = [];
    let successful = false;
    context.mocks.http.post(
      "*/api/voice-io/transcribe",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        return successful
          ? HttpResponse.json({
              transcript: "original",
              polishedText: "Original recording.",
              language: "en-US",
            })
          : HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
      },
    );
    await setupPage({
      context: { ...context, signal: initialPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    click(await findEnabledButton("Stop recording"));
    await findEnabledButton("Retry");
    const saved = await recordings();
    unload(initialPage);
    await setupPage({
      context: refreshedContext,
      path: RUN_PATH,
      featureSwitches: flags,
    });
    const originalComposer = await screen.findByRole("textbox", {
      name: "Message",
    });
    const dialog = await openForwardComposer(name);
    await findEnabledButton("Retry", dialog);
    expect(queryButton("Voice input", dialog)).toBeNull();
    await expect(recordings()).resolves.toStrictEqual(saved);
    successful = true;
    click(await findEnabledButton("Retry", dialog));
    await findEnabledButton("Voice input", dialog);
    expect(
      within(dialog).getByRole("textbox", { name: "Message" }),
    ).toHaveTextContent("Original recording.");
    expect(originalComposer).toHaveTextContent("Keep the existing notes.");
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toStrictEqual(uploads[0]);
    await expect(recordings()).resolves.toStrictEqual([]);
  },
);
