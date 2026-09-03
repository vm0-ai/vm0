import { createStore } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import { writeConnectionDiagnostic$ } from "../../signals/connection-diagnostics.ts";
import { setRootSignal$ } from "../../signals/root-signal.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
} from "../bridge.ts";
import type { ComputedKey } from "../computed-key.ts";
import type { SharedDatabaseDataKey } from "../data-key.ts";
import { MessagePortSharedDatabaseBridge } from "../message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "../message-port-server.ts";
import {
  SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
  type SharedDatabaseConnectionStatus,
} from "../protocol.ts";
import {
  broadcastSharedDatabaseWorkerMessage$,
  connectionControllers$,
  updateRealtimeStatusForConnections$,
} from "../worker-context.ts";

const context = testContext();

function createEvents(
  statuses: SharedDatabaseConnectionStatus[] = [],
): SharedDatabaseBridgeEvents {
  return {
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    databaseReconnected: vi.fn<() => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    workerUnavailable: vi.fn<SharedDatabaseBridgeEvents["workerUnavailable"]>(),
    statusChanged: (status) => {
      statuses.push(status);
    },
  };
}

function createServerStore() {
  const store = createStore();
  store.set(setRootSignal$, context.signal);
  return store;
}

class TestServerPort implements SharedDatabasePortLike {
  readonly messages: unknown[] = [];
  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  postMessage(value: unknown): void {
    this.messages.push(value);
  }

  start(): void {}

  close(): void {
    this.listener = null;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listener = listener;
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  receive(value: unknown): void {
    this.listener?.(new MessageEvent("message", { data: value }));
  }
}

describe("shared database MessagePort protocol", () => {
  it("registers a tab without sending an acknowledgement", () => {
    const store = createServerStore();
    const port = new TestServerPort();
    new SharedDatabaseMessagePortServer(store, port, context.signal);

    port.receive({ type: "register-tab" });

    expect(store.get(connectionControllers$).size).toBe(1);
    expect(port.messages).toStrictEqual([]);
  });

  it("replays the realtime status a tab missed before it registered", () => {
    const store = createServerStore();
    const port = new TestServerPort();
    new SharedDatabaseMessagePortServer(store, port, context.signal);
    store.set(updateRealtimeStatusForConnections$, "connected");

    port.receive({ type: "register-tab" });

    expect(port.messages).toStrictEqual([
      { type: "status", status: "connected" },
    ]);
  });

  it("shares one Store across independently registered tabs", () => {
    const store = createServerStore();
    const first = new TestServerPort();
    const second = new TestServerPort();
    new SharedDatabaseMessagePortServer(store, first, context.signal);
    new SharedDatabaseMessagePortServer(store, second, context.signal);

    first.receive({ type: "register-tab" });
    second.receive({ type: "register-tab" });

    expect(store.get(connectionControllers$).size).toBe(2);
  });

  it("rejects requests made before tab registration", async () => {
    const store = createServerStore();
    const channel = new MessageChannel();
    new SharedDatabaseMessagePortServer(store, channel.port1, context.signal);
    const bridge = new MessagePortSharedDatabaseBridge(
      channel.port2,
      createEvents(),
    );

    await expect(
      bridge.query(
        {
          dataKey: { kind: "chat-event", threadId: "thread-before-register" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        context.signal,
      ),
    ).rejects.toMatchObject({
      name: SHARED_DATABASE_CLIENT_NOT_CONNECTED_ERROR_NAME,
    });
  });

  it("forwards real worker events after registration", async () => {
    const store = createServerStore();
    const channel = new MessageChannel();
    const statuses: SharedDatabaseConnectionStatus[] = [];
    new SharedDatabaseMessagePortServer(store, channel.port1, context.signal);
    const bridge = new MessagePortSharedDatabaseBridge(
      channel.port2,
      createEvents(statuses),
    );
    await bridge.registerTab(context.signal);
    await vi.waitFor(() => {
      expect(store.get(connectionControllers$).size).toBe(1);
    });

    store.set(broadcastSharedDatabaseWorkerMessage$, {
      type: "status",
      status: "connected",
    });
    await vi.waitFor(() => {
      expect(statuses).toStrictEqual(["connected"]);
    });
  });

  it("serves the worker connection diagnostics capture to a tab", async () => {
    const store = createServerStore();
    store.set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: true,
    });
    store.set(writeConnectionDiagnostic$, {
      action: "append",
      event: {
        details: { connectionState: "suspended" },
        event: "realtime.connection",
        phase: "instant",
        spanId: "worker-span",
      },
    });
    const channel = new MessageChannel();
    new SharedDatabaseMessagePortServer(store, channel.port1, context.signal);
    const bridge = new MessagePortSharedDatabaseBridge(
      channel.port2,
      createEvents(),
    );
    await bridge.registerTab(context.signal);

    const diagnostics = await bridge.getComputed("connection-diagnostics");

    expect(diagnostics.enabled).toBeTruthy();
    expect(
      diagnostics.events.map((event) => {
        return event.event;
      }),
    ).toStrictEqual(["lifecycle.snapshot", "realtime.connection"]);
    expect(diagnostics.snapshot.connectionState).toBe("suspended");
  });
});
