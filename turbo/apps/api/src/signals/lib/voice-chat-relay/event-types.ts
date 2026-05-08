// Typed parsing for the OpenAI Realtime event stream and the subset of those
// events the browser is allowed to originate. The relay parses every frame
// passing through it; unknown events are tolerated (they flow through the
// pass-through layer) but malformed/disallowed browser frames close the WS.
//
// Discriminated unions are intentionally narrow — they cover the events this
// sub-issue's hooks (#12141 transcripts/tools, #12142 billing) and the
// envelope assertions in the relay-loop need to read by name. Any other
// OpenAI event flows through as `{ kind: "passthrough" }` carrying the raw
// JSON payload, so the relay never drops a frame just because we haven't
// classified it.

import { safeJsonParse } from "../../utils";

export interface SessionCreatedEvent {
  readonly kind: "session.created";
  readonly openaiSessionId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface SessionUpdatedEvent {
  readonly kind: "session.updated";
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ErrorEvent {
  readonly kind: "error";
  readonly message: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PassthroughEvent {
  readonly kind: "passthrough";
  readonly type: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ParsedOpenAiEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ErrorEvent
  | PassthroughEvent;

type ParseResult =
  | { readonly ok: true; readonly event: ParsedOpenAiEvent }
  | { readonly ok: false; readonly reason: "not-json" | "not-object" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readSessionId(
  raw: Readonly<Record<string, unknown>>,
): string | undefined {
  const session = raw["session"];
  if (!isRecord(session)) {
    return undefined;
  }
  return readString(session, "id");
}

function readErrorMessage(
  raw: Readonly<Record<string, unknown>>,
): string | undefined {
  const error = raw["error"];
  if (!isRecord(error)) {
    return undefined;
  }
  return readString(error, "message");
}

export function parseOpenAiEvent(rawText: string): ParseResult {
  const parsed = safeJsonParse(rawText);
  if (parsed === undefined) {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  const type = readString(parsed, "type");
  if (type === undefined) {
    return { ok: false, reason: "not-object" };
  }
  if (type === "session.created") {
    const openaiSessionId = readSessionId(parsed);
    return openaiSessionId === undefined
      ? {
          ok: true,
          event: { kind: "passthrough", type, raw: parsed },
        }
      : {
          ok: true,
          event: { kind: "session.created", openaiSessionId, raw: parsed },
        };
  }
  if (type === "session.updated") {
    return { ok: true, event: { kind: "session.updated", raw: parsed } };
  }
  if (type === "error") {
    const message = readErrorMessage(parsed) ?? "unknown openai error";
    return { ok: true, event: { kind: "error", message, raw: parsed } };
  }
  return { ok: true, event: { kind: "passthrough", type, raw: parsed } };
}

// Browser → relay allow-list. Any other event type closes the socket with
// code 4400. Listing literal strings (rather than reusing the OpenAI union)
// is intentional: the browser is a less-trusted origin, and being strict
// here keeps the validation surface small and obvious.
const BROWSER_ALLOWED_TYPES = [
  "session.update",
  "input_audio_buffer.append",
  "input_audio_buffer.commit",
  "input_audio_buffer.clear",
  "conversation.item.create",
  "conversation.item.truncate",
  "response.cancel",
] as const;

type BrowserAllowedType = (typeof BROWSER_ALLOWED_TYPES)[number];

export interface BrowserEvent {
  readonly type: BrowserAllowedType;
  readonly raw: Readonly<Record<string, unknown>>;
}

type BrowserParseResult =
  | { readonly ok: true; readonly event: BrowserEvent }
  | {
      readonly ok: false;
      readonly reason: "not-json" | "not-object" | "type-not-allowed";
      readonly type?: string;
    };

export function parseBrowserEvent(rawText: string): BrowserParseResult {
  const parsed = safeJsonParse(rawText);
  if (parsed === undefined) {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "not-object" };
  }
  const type = readString(parsed, "type");
  if (type === undefined) {
    return { ok: false, reason: "not-object" };
  }
  if (!(BROWSER_ALLOWED_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: "type-not-allowed", type };
  }
  return {
    ok: true,
    event: { type: type as BrowserAllowedType, raw: parsed },
  };
}

// Relay-side envelope events. Carried in the browser-facing channel only —
// never forwarded to OpenAI. Lets the platform render connection state
// without parsing OpenAI's `session.created` / `error` shapes.
export type RelayEnvelopeEvent =
  | {
      readonly type: "relay.ready";
      readonly relaySessionId: string;
      readonly openaiSessionId: string;
      readonly model: string;
    }
  | {
      readonly type: "relay.error";
      readonly code: "openai_error" | "closed_unexpectedly" | "internal";
      readonly message: string;
    }
  | {
      readonly type: "relay.closed";
      readonly reason: "graceful" | "session_ended" | "aborted";
    };
