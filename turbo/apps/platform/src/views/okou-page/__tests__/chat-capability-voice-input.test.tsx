import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  queryButton,
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

async function activeVoiceDraftStopButton(): Promise<HTMLElement> {
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  expect(stop).toHaveTextContent("OK");
  expect(
    screen.getByText(/^\d{2}:\d{2}$/u, { selector: "time" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Attach files")).not.toBeInTheDocument();
  return stop;
}

function placeCaret(
  composer: HTMLElement,
  textNodeContent: string,
  offset: number,
): void {
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && node.textContent !== textNodeContent) {
    node = walker.nextNode();
  }
  if (!node) {
    throw new Error(`Expected composer text node ${textNodeContent}`);
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  composer.focus();
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

test("Polish a voice draft into the user's current selection", async () => {
  const polishStarted = context.mocks.deferred<void>();
  const polishReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", () => {
    return HttpResponse.json({ text: "um send the launch update tomorrow" });
  });
  context.mocks.api(voiceIoPolishContract.post, async ({ body, respond }) => {
    expect(body).toStrictEqual({
      text: "um send the launch update tomorrow",
    });
    polishStarted.resolve(undefined);
    await polishReady.promise;
    return respond(200, { text: "Send the launch update tomorrow." });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
  });

  const voiceInput = await readyVoiceInput();
  await fill(currentComposer(), "Opening  closing");
  click(voiceInput);
  const stop = await activeVoiceDraftStopButton();
  expect(queryButton("Send")).toBeNull();
  click(stop);
  await polishStarted.promise;

  await waitFor(() => {
    expect(
      screen.getByText("um send the launch update tomorrow"),
    ).not.toBeVisible();
  });
  expect(screen.getByRole("status")).toHaveTextContent("Transcribing...");
  expect(queryButton("Send")).toBeNull();
  placeCaret(currentComposer(), "Opening  closing", 8);

  polishReady.resolve(undefined);

  await waitFor(() => {
    expect(normalizedComposerText()).toBe(
      "Opening Send the launch update tomorrow. closing",
    );
  });
  expect(window.getSelection()?.toString()).toBe(
    "Send the launch update tomorrow.",
  );
  await expect(findButton("Send")).resolves.toBeEnabled();
  expect(screen.queryByLabelText("Voice draft")).not.toBeInTheDocument();
});

test("Enter voice-draft recording only after the microphone starts", async () => {
  const microphoneReady = context.mocks.deferred<void>();
  context.mocks.browser.voiceInput({
    getUserMediaReady: microphoneReady.promise,
    rms: 0,
  });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
  });

  click(await readyVoiceInput());

  await expect(findButton("Starting voice input")).resolves.toBeDisabled();
  expect(
    document.querySelector("[data-voice-level-waveform]"),
  ).not.toBeInTheDocument();

  microphoneReady.resolve(undefined);

  await activeVoiceDraftStopButton();
  expect(
    document.querySelector("[data-voice-level-waveform]"),
  ).toBeInTheDocument();
});

test("Show recent voice levels at the end of the waveform", async () => {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
  });

  click(await readyVoiceInput());
  await activeVoiceDraftStopButton();

  const waveform = document.querySelector("[data-voice-level-waveform]");
  if (!(waveform instanceof HTMLElement)) {
    throw new Error("Voice level waveform not found");
  }

  await waitFor(() => {
    const bars = Array.from(waveform.children);
    expect(bars).toHaveLength(32);
    expect(bars[0]).toHaveStyle({ height: "4px" });
    expect(bars.at(-1)).toHaveStyle({ height: "16px" });
  });
});

test("Let the user retry or remove a voice draft when polishing fails", async () => {
  let polishAttempts = 0;
  context.mocks.browser.voiceInput({ rms: 0.12 });
  installAvailableVoiceQuota();
  context.mocks.http.post("*/api/voice-io/stt", () => {
    return HttpResponse.json({ text: "raw launch update" });
  });
  context.mocks.api(voiceIoPolishContract.post, ({ respond }) => {
    polishAttempts += 1;
    if (polishAttempts === 1) {
      return respond(503, {
        error: {
          code: "VOICE_POLISH_UNAVAILABLE",
          message: "Voice polish is temporarily unavailable",
        },
      });
    }
    return respond(200, { text: "Polished launch update." });
  });
  installRunChat();

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
  });

  click(await readyVoiceInput());
  click(await activeVoiceDraftStopButton());

  const draft = await screen.findByLabelText("Voice draft");
  expect(draft).toBeVisible();
  expect(draft).toHaveTextContent("raw launch update");
  await expect(findButton("Finish")).resolves.toBeEnabled();
  await expect(findButton("Remove voice draft")).resolves.toBeEnabled();
  await expect(findButton("Send")).resolves.toBeDisabled();

  click(await findButton("Finish"));

  await waitFor(() => {
    expect(normalizedComposerText()).toBe("Polished launch update.");
  });
  expect(polishAttempts).toBe(2);
  await expect(findButton("Send")).resolves.toBeEnabled();
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
