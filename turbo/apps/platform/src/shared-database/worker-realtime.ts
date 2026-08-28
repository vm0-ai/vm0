import type {
  AuthOptions,
  ConnectionStateChange,
  InboundMessage,
  TokenRequest,
} from "ably";
import { createAblyRealtime } from "../lib/ably-realtime.ts";
import { logger } from "../signals/log.ts";
import { createChildAbortController } from "../signals/utils.ts";
import type { SharedDatabaseConnectionStatus } from "./protocol.ts";

const L = logger("SharedDatabaseWorker");

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
  L.debug("realtime.create", { userId: options.userId });
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    const authenticate = async (): Promise<void> => {
      L.debug("realtime.auth.start", { userId: options.userId });
      const [result] = await Promise.allSettled([options.getTokenRequest()]);
      if (controller.signal.aborted) {
        return;
      }
      if (result?.status === "fulfilled") {
        L.debug("realtime.auth.finish", { userId: options.userId });
        callback(null, result.value);
        return;
      }
      L.debug("realtime.auth.error", {
        error: result?.reason,
        userId: options.userId,
      });
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

  const ably = createAblyRealtime({
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
    L.debug("realtime.connection", {
      current: stateChange.current,
      previous: stateChange.previous,
      reason: stateChange.reason,
      retryIn: stateChange.retryIn,
      userId: options.userId,
    });
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
      L.debug("realtime.message", {
        name: message.name,
        userId: options.userId,
      });
      options.onMessage(message);
    }
  };
  const subscribe = async (): Promise<boolean> => {
    L.debug("realtime.channel.start", { userId: options.userId });
    const [result] = await Promise.allSettled([
      channel.subscribe(handleMessage),
    ]);
    if (controller.signal.aborted) {
      return false;
    }
    const attached = result?.status === "fulfilled";
    channelState = attached ? "attached" : "failed";
    L.debug(attached ? "realtime.channel.finish" : "realtime.channel.error", {
      error: result?.status === "rejected" ? result.reason : undefined,
      userId: options.userId,
    });
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
      L.debug("realtime.close", { userId: options.userId });
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
