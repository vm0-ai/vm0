import { describe, expect, it } from "vitest";

import { parseBrowserEvent, parseOpenAiEvent } from "../event-types";

describe("parseOpenAiEvent", () => {
  it("recognises session.created and extracts the session id", () => {
    const result = parseOpenAiEvent(
      JSON.stringify({
        type: "session.created",
        session: { id: "sess_abc" },
      }),
    );
    expect(result.ok).toBeTruthy();
    if (result.ok) {
      expect(result.event.kind).toBe("session.created");
      if (result.event.kind === "session.created") {
        expect(result.event.openaiSessionId).toBe("sess_abc");
      }
    }
  });

  it("falls back to passthrough when session.created lacks an id", () => {
    const result = parseOpenAiEvent(
      JSON.stringify({ type: "session.created" }),
    );
    expect(result.ok).toBeTruthy();
    if (result.ok) {
      expect(result.event.kind).toBe("passthrough");
    }
  });

  it("recognises error events and extracts the message", () => {
    const result = parseOpenAiEvent(
      JSON.stringify({
        type: "error",
        error: { message: "rate limit exceeded" },
      }),
    );
    expect(result.ok).toBeTruthy();
    if (result.ok) {
      expect(result.event.kind).toBe("error");
      if (result.event.kind === "error") {
        expect(result.event.message).toBe("rate limit exceeded");
      }
    }
  });

  it("classifies known events with no special carrier as passthrough", () => {
    const result = parseOpenAiEvent(
      JSON.stringify({
        type: "response.audio.delta",
        delta: "AAAA",
      }),
    );
    expect(result.ok).toBeTruthy();
    if (result.ok && result.event.kind === "passthrough") {
      expect(result.event.type).toBe("response.audio.delta");
    } else {
      throw new Error("expected passthrough event");
    }
  });

  it("rejects non-JSON input", () => {
    const result = parseOpenAiEvent("{not-json");
    expect(result.ok).toBeFalsy();
    if (!result.ok) {
      expect(result.reason).toBe("not-json");
    }
  });

  it("rejects JSON arrays / primitives", () => {
    const result = parseOpenAiEvent(JSON.stringify(["hello"]));
    expect(result.ok).toBeFalsy();
    if (!result.ok) {
      expect(result.reason).toBe("not-object");
    }
  });

  it("rejects objects without a type discriminator", () => {
    const result = parseOpenAiEvent(JSON.stringify({ payload: 1 }));
    expect(result.ok).toBeFalsy();
  });
});

describe("parseBrowserEvent", () => {
  it.each([
    "session.update",
    "input_audio_buffer.append",
    "input_audio_buffer.commit",
    "input_audio_buffer.clear",
    "conversation.item.create",
    "conversation.item.truncate",
    "response.cancel",
  ])("accepts allow-listed type %s", (type) => {
    const result = parseBrowserEvent(JSON.stringify({ type }));
    expect(result.ok).toBeTruthy();
  });

  it.each(["response.done", "session.created", "anything-else"])(
    "rejects non-allowlisted type %s with type-not-allowed",
    (type) => {
      const result = parseBrowserEvent(JSON.stringify({ type }));
      expect(result.ok).toBeFalsy();
      if (!result.ok) {
        expect(result.reason).toBe("type-not-allowed");
        expect(result.type).toBe(type);
      }
    },
  );

  it("rejects malformed JSON", () => {
    const result = parseBrowserEvent("not-json");
    expect(result.ok).toBeFalsy();
    if (!result.ok) {
      expect(result.reason).toBe("not-json");
    }
  });

  it("rejects events without a type discriminator", () => {
    const result = parseBrowserEvent(JSON.stringify({ data: "x" }));
    expect(result.ok).toBeFalsy();
  });
});
