import {
  Realtime,
  type AuthOptions,
  type ConnectionStateChange,
  type InboundMessage,
  type TokenRequest,
} from "ably";
import { createChildAbortController } from "../signals/utils.ts";
import type { SharedDatabaseConnectionStatus } from "./protocol.ts";

interface SharedDatabaseRealtimeOptions {
  readonly userId: string;
  readonly getTokenRequest: () => Promise<TokenRequest>;
  readonly onMessage: (message: InboundMessage) => void;
  readonly onStatus: (status: SharedDatabaseConnectionStatus) => void;
}

export interface SharedDatabaseRealtimeSession {
  readonly ready: Promise<boolean>;
  readonly close: () => void;
}

function connectionStatus(
  state: ConnectionStateChange["current"],
): SharedDatabaseConnectionStatus {
  if (state === "connected") {
    return "connected";
  }
  if (
    state === "closed" ||
    state === "disconnected" ||
    state === "failed" ||
    state === "suspended"
  ) {
    return "disconnected";
  }
  return "connecting";
}

export function createSharedDatabaseRealtimeSession(
  options: SharedDatabaseRealtimeOptions,
  signal: AbortSignal,
): SharedDatabaseRealtimeSession {
  const controller = createChildAbortController(signal);
  const pendingAuthTasks = new Set<Promise<void>>();
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    const authenticate = async (): Promise<void> => {
      const [result] = await Promise.allSettled([options.getTokenRequest()]);
      if (controller.signal.aborted) {
        return;
      }
      if (result?.status === "fulfilled") {
        callback(null, result.value);
        return;
      }
      callback(
        result?.reason instanceof Error
          ? result.reason.message
          : String(result?.reason),
        null,
      );
    };
    pendingAuthTasks.clear();
    pendingAuthTasks.add(authenticate());
  };

  const ably = new Realtime({
    authCallback,
    autoConnect: true,
    disconnectedRetryTimeout: 5000,
    suspendedRetryTimeout: 15_000,
  });
  const channel = ably.channels.get(`user:${options.userId}`);
  let channelState: "attached" | "attaching" | "failed" = "attaching";
  const handleConnectionStateChange = (
    stateChange: ConnectionStateChange,
  ): void => {
    const status = connectionStatus(stateChange.current);
    options.onStatus(
      status !== "connected"
        ? status
        : channelState === "attached"
          ? "connected"
          : channelState === "failed"
            ? "disconnected"
            : "connecting",
    );
  };
  ably.connection.on(handleConnectionStateChange);

  const handleMessage = (message: InboundMessage): void => {
    if (!controller.signal.aborted) {
      options.onMessage(message);
    }
  };
  const subscribe = async (): Promise<boolean> => {
    const [result] = await Promise.allSettled([
      channel.subscribe(handleMessage),
    ]);
    if (controller.signal.aborted) {
      return false;
    }
    const attached = result?.status === "fulfilled";
    channelState = attached ? "attached" : "failed";
    options.onStatus(attached ? "connected" : "disconnected");
    return attached;
  };
  const ready = subscribe();

  let closed = false;
  return {
    ready,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort(
        new DOMException("Shared database realtime closed", "AbortError"),
      );
      pendingAuthTasks.clear();
      channel.unsubscribe(handleMessage);
      ably.connection.off(handleConnectionStateChange);
      ably.close();
    },
  };
}
