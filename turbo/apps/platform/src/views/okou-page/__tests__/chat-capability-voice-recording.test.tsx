import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { openDB, type DBSchema } from "idb";
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
interface RecordingDatabase extends DBSchema {
  drafts: {
    key: string;
    value: { id: string; sampleCount: number; chunkCount: number };
  };
}

async function savedRecording() {
  const database = await openDB<RecordingDatabase>("okou-voice-drafts", 1);
  const recordings = await database.getAll("drafts");
  database.close();
  return recordings[0] ?? null;
}

function releasePageDom() {
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

function unload(page: AbortController) {
  const error = new Error("Page reloaded");
  error.name = "AbortError";
  page.abort(error);
  releasePageDom();
}

function installVoiceBoundaries() {
  installRunChat();
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
      (args[0] === "[E][Composer:VoiceDraft]" &&
        (args[1] === "Voice draft transcription failed" ||
          args[1] === "Voice recording could not be saved")) ||
      (args[0] === "[E][VoiceIO:STT]" &&
        args[1] === "Voice recording failed to finish")
    ) {
      errors.push(args);
      return;
    }
    original(...args);
  });
  return errors;
}

async function uploadedAudio(request: Request): Promise<ArrayBuffer> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Expected recorded audio");
  }
  return await file.arrayBuffer();
}

const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;

test.each([RUN_PATH, NEW_CHAT_PATH])(
  "Recover committed PCM after reloading during recording at %s",
  async (path) => {
    const firstPage = createChildAbortController(context.signal);
    const secondPage = createChildAbortController(secondContext.signal);
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
    });
    const consoleErrors = installVoiceBoundaries();
    const uploads: ArrayBuffer[] = [];
    context.mocks.http.post(
      "*/api/voice-io/transcribe",
      async ({ request }) => {
        uploads.push(await uploadedAudio(request));
        if (uploads.length < 3) {
          return HttpResponse.json(
            { error: "Temporary outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          transcript: "recovered",
          polishedText: "Recovered audio.",
          language: "en-US",
        });
      },
    );
    await setupPage({
      context: { ...context, signal: firstPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Voice input"));
    await findEnabledButton("Stop recording");
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    await waitFor(async () => {
      await expect(savedRecording()).resolves.toMatchObject({
        sampleCount: 4096,
        chunkCount: 1,
      });
    });
    unload(firstPage);
    await setupPage({
      context: { ...secondContext, signal: secondPage.signal },
      path,
      featureSwitches: flags,
    });
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Retry");
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Retry");
    expect(queryButton("Stop recording")).toBeNull();
    unload(secondPage);
    await setupPage({ context: thirdContext, path, featureSwitches: flags });
    click(await findEnabledButton("Retry"));
    await findEnabledButton("Voice input");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Recovered audio.",
    );
    expect(uploads).toHaveLength(3);
    expect(uploads[1]).toStrictEqual(uploads[0]);
    expect(uploads[2]).toStrictEqual(uploads[0]);
    const samples = decodeVoiceDraftPcmWav(uploads[0]!);
    expect(samples).toHaveLength(4096);
    expect(samples?.at(-1)).toBeCloseTo(0.25, 4);
    await waitFor(async () => {
      return await expect(savedRecording()).resolves.toBeNull();
    });
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

test.each([RUN_PATH, NEW_CHAT_PATH])(
  "Include the final worklet chunk before transcribing at %s",
  async (path) => {
    const capture = context.mocks.deferred<(samples: Float32Array) => void>();
    const upload = context.mocks.deferred<ArrayBuffer>();
    context.mocks.browser.voiceInput({
      rms: 0.12,
      onPcmCapture: capture.resolve,
      finalPcmSamples: new Float32Array(1024).fill(-0.75),
    });
    const consoleErrors = installVoiceBoundaries();
    context.mocks.http.post(
      "*/api/voice-io/transcribe",
      async ({ request }) => {
        upload.resolve(await uploadedAudio(request));
        return HttpResponse.json({
          transcript: "complete",
          polishedText: "Complete recording.",
          language: "en-US",
        });
      },
    );
    await setupPage({ context, path, featureSwitches: flags });
    click(await findEnabledButton("Voice input"));
    const emit = await capture.promise;
    emit(new Float32Array(4096).fill(0.25));
    // Stop immediately: it must drain both queued writes and the final chunk.
    click(await findEnabledButton("Stop recording"));
    const samples = decodeVoiceDraftPcmWav(await upload.promise);
    expect(samples).toHaveLength(5120);
    expect(samples?.[4095]).toBeCloseTo(0.25, 4);
    expect(samples?.[4096]).toBeCloseTo(-0.75, 4);
    expect(samples?.at(-1)).toBeCloseTo(-0.75, 4);
    await findEnabledButton("Voice input");
    await waitFor(async () => {
      return await expect(savedRecording()).resolves.toBeNull();
    });
    expect(consoleErrors).toStrictEqual([]);
  },
);

test("Keep the active tab's recording until its owner closes", async () => {
  const firstPage = createChildAbortController(context.signal);
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: capture.resolve,
  });
  const consoleErrors = installVoiceBoundaries();
  await setupPage({
    context: { ...context, signal: firstPage.signal },
    path: RUN_PATH,
    featureSwitches: flags,
  });
  click(await findEnabledButton("Voice input"));
  await findEnabledButton("Stop recording");
  const emit = await capture.promise;
  emit(new Float32Array(4096).fill(0.25));
  await waitFor(async () => {
    return await expect(savedRecording()).resolves.toMatchObject({
      sampleCount: 4096,
    });
  });
  const original = await savedRecording();
  // A second browser runtime mounts while the first recording owner stays alive.
  releasePageDom();
  await setupPage({
    context: secondContext,
    path: RUN_PATH,
    featureSwitches: flags,
  });
  await screen.findByText(
    "This conversation has an active recording in another tab. Retry after it stops.",
  );
  click(await findEnabledButton("Retry"));
  await screen.findByText(
    "This conversation has an active recording in another tab. Retry after it stops.",
  );
  await expect(savedRecording()).resolves.toStrictEqual(original);
  expect(queryButton("Voice input")).toBeNull();
  const error = new Error("First tab closed");
  error.name = "AbortError";
  firstPage.abort(error);
  click(await findEnabledButton("Retry"));
  await findEnabledButton("Remove voice draft");
  click(await findEnabledButton("Remove voice draft"));
  await findEnabledButton("Voice input");
  await expect(savedRecording()).resolves.toBeNull();
  expect(consoleErrors).toStrictEqual([]);
});

test("Stop capture and expose a failed chunk write without discarding the saved prefix", async () => {
  const capture = context.mocks.deferred<(samples: Float32Array) => void>();
  context.mocks.browser.voiceInput({
    rms: 0.12,
    onPcmCapture: capture.resolve,
  });
  const consoleErrors = installVoiceBoundaries();
  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  await findEnabledButton("Stop recording");
  const emit = await capture.promise;
  emit(new Float32Array(4096).fill(0.25));
  await waitFor(async () => {
    return await expect(savedRecording()).resolves.toMatchObject({
      sampleCount: 4096,
    });
  });
  const add = IDBObjectStore.prototype.add;
  const storageError = new DOMException(
    "Storage is full",
    "QuotaExceededError",
  );
  vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    if (this.name === "chunks") {
      throw storageError;
    }
    return add.apply(this, args);
  });
  emit(new Float32Array(4096).fill(0.5));
  await findEnabledButton("Retry");
  expect(
    screen.getAllByText(
      "Audio could not be saved. Retry can recover only audio already saved on this device.",
    ).length,
  ).toBeGreaterThan(0);
  expect(queryButton("Stop recording")).toBeNull();
  await expect(savedRecording()).resolves.toMatchObject({
    sampleCount: 4096,
    chunkCount: 1,
  });
  expect(consoleErrors).toStrictEqual([
    [
      "[E][Composer:VoiceDraft]",
      "Voice recording could not be saved",
      storageError,
    ],
    ["[E][VoiceIO:STT]", "Voice recording failed to finish", storageError],
  ]);
});

test("Restore audio when voice input v2 enables after the composer mounts", async () => {
  const firstPage = createChildAbortController(context.signal);
  context.mocks.browser.voiceInput({ rms: 0.12 });
  const consoleErrors = installVoiceBoundaries();
  context.mocks.http.post("*/api/voice-io/transcribe", () => {
    return HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
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
  const enableVoice = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await enableVoice.promise;
    return respond(200, { switches: flags, effectiveSwitches: flags });
  });
  await setupPage({
    context: secondContext,
    path: RUN_PATH,
    cachedFeatureSwitches: { [FeatureSwitchKey.VoiceInputV2]: false },
  });
  await expect(findEnabledButton("Voice input")).resolves.not.toHaveAttribute(
    "aria-keyshortcuts",
  );
  expect(queryButton("Retry")).toBeNull();
  enableVoice.resolve();
  await findEnabledButton("Retry");
  expect(queryButton("Stop recording")).toBeNull();
  click(await findEnabledButton("Remove voice draft"));
  await expect(findEnabledButton("Voice input")).resolves.toHaveAttribute(
    "aria-keyshortcuts",
  );
  await expect(savedRecording()).resolves.toBeNull();
  expect(consoleErrors).toStrictEqual([
    [
      "[E][Composer:VoiceDraft]",
      "Voice draft transcription failed",
      expect.objectContaining({ status: 503, code: "UNKNOWN" }),
    ],
  ]);
});
