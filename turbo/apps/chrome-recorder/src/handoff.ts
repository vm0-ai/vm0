import {
  isOkouRecorderPageMessage,
  OKOU_RECORDER_CHANNEL,
  OKOU_RECORDER_PROTOCOL_VERSION,
  type OkouRecorderPageMessage,
} from "@okouai/core/browser-recorder-protocol";

import { extensionMessage } from "./messages.ts";
import { deleteRecording, readRecording } from "./recording-store.ts";

const sessionId = location.hash.slice(1);
const parentOrigin = document.referrer
  ? new URL(document.referrer).origin
  : null;

function toParent(message: OkouRecorderPageMessage): void {
  if (!parentOrigin) {
    return;
  }
  window.parent.postMessage(message, parentOrigin);
}

async function deliverRecording(): Promise<void> {
  const recording = await readRecording(sessionId);
  if (!recording) {
    toParent({
      channel: OKOU_RECORDER_CHANNEL,
      code: "recording-missing",
      sessionId,
      source: "extension",
      type: "handoff:error",
      version: OKOU_RECORDER_PROTOCOL_VERSION,
    });
    return;
  }
  toParent({
    channel: OKOU_RECORDER_CHANNEL,
    recording: {
      blob: recording.blob,
      contentType: recording.contentType,
      durationSeconds: recording.durationSeconds,
      name: recording.name,
    },
    sessionId,
    source: "extension",
    type: "handoff:recording",
    version: OKOU_RECORDER_PROTOCOL_VERSION,
  });
}

async function completeHandoff(): Promise<void> {
  await deleteRecording(sessionId);
  await chrome.runtime.sendMessage(
    extensionMessage({
      recipient: "worker",
      sessionId,
      type: "handoff:consumed",
    }),
  );
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message: unknown = event.data;
  if (
    event.origin !== parentOrigin ||
    !isOkouRecorderPageMessage(message) ||
    message.source !== "platform" ||
    message.sessionId !== sessionId
  ) {
    return;
  }
  if (message.type === "handoff:ready") {
    void deliverRecording();
    return;
  }
  if (message.type === "handoff:complete") {
    void completeHandoff();
  }
});
