import { describe, expect, it } from "vitest";

import {
  isOkouAppUrl,
  isOkouRecorderPageMessage,
  OKOU_RECORDER_CHANNEL,
  OKOU_RECORDER_PROTOCOL_VERSION,
  okouRecorderSessionId,
} from "./browser-recorder-protocol";

describe("browser recorder protocol", () => {
  it("accepts a recording handoff with a Blob", () => {
    expect(
      isOkouRecorderPageMessage({
        channel: OKOU_RECORDER_CHANNEL,
        recording: {
          blob: new Blob(["recording"], { type: "video/webm" }),
          contentType: "video/webm",
          durationSeconds: 12.5,
          name: "Okou recording.webm",
        },
        sessionId: "session-1",
        source: "extension",
        type: "handoff:recording",
        version: OKOU_RECORDER_PROTOCOL_VERSION,
      }),
    ).toBe(true);
  });

  it("rejects messages from the wrong protocol version", () => {
    expect(
      isOkouRecorderPageMessage({
        channel: OKOU_RECORDER_CHANNEL,
        sessionId: "session-1",
        source: "platform",
        type: "handoff:ready",
        version: 2,
      }),
    ).toBe(false);
  });

  it.each([
    "https://app.okou.ai/",
    "https://app.vm0.ai/agents",
    "https://staging-app.vm7.ai/",
    "https://pr-123-app.vm6.ai/",
    "http://localhost:3002/",
  ])("recognizes an Okou application URL: %s", (url) => {
    expect(isOkouAppUrl(url)).toBe(true);
  });

  it.each([
    "https://app.okou.ai.evil.example/",
    "https://okou.ai/",
    "https://example.com/",
  ])("rejects a non-application URL: %s", (url) => {
    expect(isOkouAppUrl(url)).toBe(false);
  });

  it("reads only bounded non-empty handoff session identifiers", () => {
    expect(
      okouRecorderSessionId(
        new URL("https://app.okou.ai/?okouRecorderSession=session-1"),
      ),
    ).toBe("session-1");
    expect(
      okouRecorderSessionId(
        new URL("https://app.okou.ai/?okouRecorderSession="),
      ),
    ).toBeNull();
  });
});
