const EXTENSION_MESSAGE_CHANNEL = "okou-recorder-internal";
const EXTENSION_MESSAGE_VERSION = 1;

export type RecorderSessionStatus =
  | "finalizing"
  | "paused"
  | "ready"
  | "recording";

export interface RecorderStateSnapshot {
  readonly elapsedSeconds: number;
  readonly microphone: boolean;
  readonly status: RecorderSessionStatus;
  readonly tabAudio: boolean;
}

interface ExtensionMessageBase {
  readonly channel: typeof EXTENSION_MESSAGE_CHANNEL;
  readonly version: typeof EXTENSION_MESSAGE_VERSION;
}

export type WorkerMessage =
  | (ExtensionMessageBase & {
      readonly recipient: "worker";
      readonly type: "content:mounted";
    })
  | (ExtensionMessageBase & {
      readonly action: "cancel" | "finish" | "pause" | "resume" | "start";
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly type: "content:command";
    })
  | (ExtensionMessageBase & {
      readonly enabled: boolean;
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly type: "content:microphone";
    })
  | (ExtensionMessageBase & {
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly state: RecorderStateSnapshot;
      readonly type: "offscreen:state";
    })
  | (ExtensionMessageBase & {
      readonly durationSeconds: number;
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly type: "offscreen:completed";
    })
  | (ExtensionMessageBase & {
      readonly code:
        | "capture-ended"
        | "capture-failed"
        | "microphone-permission";
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly type: "offscreen:error";
    })
  | (ExtensionMessageBase & {
      readonly recipient: "worker";
      readonly sessionId: string;
      readonly type: "handoff:consumed";
    });

export type ContentMessage =
  | (ExtensionMessageBase & {
      readonly recipient: "content";
      readonly sessionId: string;
      readonly state: RecorderStateSnapshot;
      readonly type: "worker:prepare";
    })
  | (ExtensionMessageBase & {
      readonly recipient: "content";
      readonly sessionId: string;
      readonly state: RecorderStateSnapshot;
      readonly type: "worker:state";
    })
  | (ExtensionMessageBase & {
      readonly recipient: "content";
      readonly sessionId: string;
      readonly type: "worker:cleanup";
    })
  | (ExtensionMessageBase & {
      readonly code:
        | "capture-ended"
        | "capture-failed"
        | "microphone-permission";
      readonly recipient: "content";
      readonly sessionId: string;
      readonly type: "worker:error";
    });

export type OffscreenMessage =
  | (ExtensionMessageBase & {
      readonly recipient: "offscreen";
      readonly sessionId: string;
      readonly type: "worker:select-source";
    })
  | (ExtensionMessageBase & {
      readonly action: "cancel" | "finish" | "pause" | "resume" | "start";
      readonly recipient: "offscreen";
      readonly sessionId: string;
      readonly type: "worker:command";
    })
  | (ExtensionMessageBase & {
      readonly enabled: boolean;
      readonly recipient: "offscreen";
      readonly sessionId: string;
      readonly type: "worker:microphone";
    });

type RuntimeMessage = ContentMessage | OffscreenMessage | WorkerMessage;

export type CaptureSelection =
  | {
      readonly ok: true;
      readonly tabAudio: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "cancelled" | "failed" | "tab-required";
    };

type MessageBody = RuntimeMessage extends infer T
  ? T extends RuntimeMessage
    ? Omit<T, "channel" | "version">
    : never
  : never;

export function extensionMessage<T extends MessageBody>(
  message: T,
): ExtensionMessageBase & T {
  return {
    ...message,
    channel: EXTENSION_MESSAGE_CHANNEL,
    version: EXTENSION_MESSAGE_VERSION,
  };
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Readonly<Record<string, unknown>>;
  return (
    message.channel === EXTENSION_MESSAGE_CHANNEL &&
    message.version === EXTENSION_MESSAGE_VERSION &&
    typeof message.recipient === "string" &&
    typeof message.type === "string"
  );
}

export function isCaptureSelection(value: unknown): value is CaptureSelection {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  const selection = value as Readonly<Record<string, unknown>>;
  return selection.ok === true
    ? typeof selection.tabAudio === "boolean"
    : selection.ok === false &&
        ["cancelled", "failed", "tab-required"].includes(
          String(selection.reason),
        );
}
