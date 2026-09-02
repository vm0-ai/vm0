import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

interface CapturedVoiceSend {
  readonly prompt: string;
}

function installAvailableVoiceQuota(limit: number | null = 60): void {
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit });
  });
}

async function readyVoiceInput(): Promise<HTMLElement> {
  await readyChat();
  const voiceInput = await findButton("Voice input");
  expect(voiceInput).toBeEnabled();
  return voiceInput;
}

function currentComposer(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

function normalizedComposerText(): string {
  return currentComposer().textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

async function activeVoiceStopButton(): Promise<HTMLElement> {
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    const meter = Array.from(
      stop.querySelectorAll<HTMLElement>("[style]"),
    ).find((element) => {
      return element.style.getPropertyValue("--mic-volume-fill") !== "";
    });
    expect(meter?.style.getPropertyValue("--mic-volume-fill")).toBe("100%");
  });
  return stop;
}

test("Add voice transcription to the current message draft", async () => {
  const user = userEvent.setup({ delay: null });
  const delayedTranscript = context.mocks.deferred<void>();
  let transcriptionRequest = 0;
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", async () => {
    transcriptionRequest += 1;
    if (transcriptionRequest === 2) {
      await delayedTranscript.promise;
    }
    return HttpResponse.json({
      text:
        transcriptionRequest === 1 ? "Record the agenda" : "Add action owners",
    });
  });
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  click(await activeVoiceStopButton());

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Record the agenda");
  });
  await expect(findButton("Voice input")).resolves.toBeEnabled();
  expect(normalizedComposerText()).toBe("Record the agenda");

  click(await findButton("Voice input"));
  click(await activeVoiceStopButton());
  await expect(findButton("Transcribing")).resolves.toBeDisabled();

  await user.click(currentComposer());
  await user.keyboard(" and typed notes");
  expect(normalizedComposerText()).toBe("Record the agenda and typed notes");

  delayedTranscript.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Record the agenda and typed notes Add action owners",
    );
  });
  await expect(findButton("Voice input")).resolves.toBeEnabled();
});

test("Make voice-input startup and silent cancellation clear", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  const voiceActivityObserved = context.mocks.deferred<void>();
  let transcriptionRequests = 0;
  const sends: CapturedVoiceSend[] = [];
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    rms: () => {
      if (!voiceActivityObserved.settled()) {
        voiceActivityObserved.resolve(undefined);
      }
      return 0;
    },
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", () => {
    transcriptionRequests += 1;
    return HttpResponse.json({ text: "Unexpected silent transcript" });
  });
  installRunChat({
    onSendRequest(body) {
      sends.push({ prompt: body.prompt });
    },
  });

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(findButton("Starting voice input")).resolves.toBeDisabled();

  microphoneReady.resolve(undefined);

  const stopRecording = await findButton("Stop recording");
  await voiceActivityObserved.promise;
  click(stopRecording);

  await expect(findButton("Voice input")).resolves.toBeEnabled();
  expect(normalizedComposerText()).toBe("");
  expect(transcriptionRequests).toBe(0);
  expect(sends).toHaveLength(0);
});

test("Transcribe long voice dictation in ordered segments", async () => {
  type SpeechPhase = "first" | "pause" | "second" | "silence";
  let phase: SpeechPhase = "first";
  let requestNumber = 0;
  const firstRequestStarted = context.mocks.deferred<void>();
  const firstTranscriptReady = context.mocks.deferred<void>();
  const secondRequestStarted = context.mocks.deferred<void>();
  const secondTranscriptReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    rms: () => {
      return phase === "first" || phase === "second" ? 0.12 : 0;
    },
  });
  installAvailableVoiceQuota(null);
  context.mocks.http.post("*/api/voice-io/stt", async () => {
    requestNumber += 1;
    if (requestNumber === 1) {
      firstRequestStarted.resolve(undefined);
      await firstTranscriptReady.promise;
      return HttpResponse.json({ text: "First dictated segment" });
    }
    secondRequestStarted.resolve(undefined);
    await secondTranscriptReady.promise;
    return HttpResponse.json({ text: "Second dictated segment" });
  });
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  await activeVoiceStopButton();

  phase = "pause";
  await firstRequestStarted.promise;
  phase = "second";

  expect(normalizedComposerText()).toBe("");
  await expect(findButton("Stop recording")).resolves.toBeEnabled();

  await activeVoiceStopButton();
  phase = "silence";

  firstTranscriptReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("First dictated segment");
  });
  await secondRequestStarted.promise;
  expect(normalizedComposerText()).toBe("First dictated segment");

  secondTranscriptReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "First dictated segment Second dictated segment",
    );
  });
  await expect(findButton("Voice input")).resolves.toBeEnabled();
});

test("Wait for voice transcription before sending a message", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  const transcriptReady = context.mocks.deferred<void>();
  const transcriptionStarted = context.mocks.deferred<void>();
  const recorderStarted = context.mocks.deferred<void>();
  const sends: CapturedVoiceSend[] = [];
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    onRecorderStart() {
      recorderStarted.resolve(undefined);
    },
  });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", async () => {
    transcriptionStarted.resolve(undefined);
    await transcriptReady.promise;
    return HttpResponse.json({ text: "spoken conclusion" });
  });
  installRunChat({
    onSendRequest(body) {
      sends.push({ prompt: body.prompt });
    },
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await fill(currentComposer(), "Typed introduction");
  click(await findButton("Voice input"));
  await expect(findButton("Starting voice input")).resolves.toBeDisabled();

  click(await findButton("Send"));

  expect(sends).toHaveLength(0);
  microphoneReady.resolve(undefined);
  await recorderStarted.promise;
  await transcriptionStarted.promise;
  expect(sends).toHaveLength(0);
  await expect(findButton("Transcribing")).resolves.toBeDisabled();

  transcriptReady.resolve(undefined);

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(sends[0]?.prompt.replace(/\s+/gu, " ").trim()).toBe(
    "Typed introduction spoken conclusion",
  );
});
