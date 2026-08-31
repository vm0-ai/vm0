export const OKOU_RECORDER_CHANNEL = "okou-recorder";
export const OKOU_RECORDER_PROTOCOL_VERSION = 1;
export const OKOU_RECORDER_SESSION_QUERY = "okouRecorderSession";

export type OkouRecorderPageMessage =
  | {
      readonly channel: typeof OKOU_RECORDER_CHANNEL;
      readonly sessionId: string;
      readonly source: "platform";
      readonly type: "handoff:ready";
      readonly version: typeof OKOU_RECORDER_PROTOCOL_VERSION;
    }
  | {
      readonly channel: typeof OKOU_RECORDER_CHANNEL;
      readonly recording: {
        readonly blob: Blob;
        readonly contentType: string;
        readonly durationSeconds: number;
        readonly name: string;
      };
      readonly sessionId: string;
      readonly source: "extension";
      readonly type: "handoff:recording";
      readonly version: typeof OKOU_RECORDER_PROTOCOL_VERSION;
    }
  | {
      readonly channel: typeof OKOU_RECORDER_CHANNEL;
      readonly code: "recording-missing";
      readonly sessionId: string;
      readonly source: "extension";
      readonly type: "handoff:error";
      readonly version: typeof OKOU_RECORDER_PROTOCOL_VERSION;
    }
  | {
      readonly channel: typeof OKOU_RECORDER_CHANNEL;
      readonly sessionId: string;
      readonly source: "platform";
      readonly type: "handoff:complete";
      readonly version: typeof OKOU_RECORDER_PROTOCOL_VERSION;
    };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isRecording(
  value: unknown,
): value is Extract<
  OkouRecorderPageMessage,
  { readonly type: "handoff:recording" }
>["recording"] {
  return (
    isRecord(value) &&
    value.blob instanceof Blob &&
    typeof value.contentType === "string" &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds >= 0 &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

export function isOkouRecorderPageMessage(
  value: unknown,
): value is OkouRecorderPageMessage {
  if (
    !isRecord(value) ||
    value.channel !== OKOU_RECORDER_CHANNEL ||
    value.version !== OKOU_RECORDER_PROTOCOL_VERSION
  ) {
    return false;
  }

  switch (value.type) {
    case "handoff:ready":
    case "handoff:complete": {
      return value.source === "platform" && isIdentifier(value.sessionId);
    }
    case "handoff:recording": {
      return (
        value.source === "extension" &&
        isIdentifier(value.sessionId) &&
        isRecording(value.recording)
      );
    }
    case "handoff:error": {
      return (
        value.source === "extension" &&
        value.code === "recording-missing" &&
        isIdentifier(value.sessionId)
      );
    }
    default: {
      return false;
    }
  }
}

export function okouRecorderSessionId(url: URL): string | null {
  const sessionId = url.searchParams.get(OKOU_RECORDER_SESSION_QUERY);
  return isIdentifier(sessionId) ? sessionId : null;
}

export function isOkouAppUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") {
    return (
      url.hostname === "app.okou.ai" ||
      url.hostname === "app.vm0.ai" ||
      url.hostname === "staging-app.vm7.ai" ||
      /^pr-\d+-app\.vm6\.ai$/u.test(url.hostname)
    );
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}
