import { vi } from "vitest";

interface NangoEvent {
  type: "connect" | "close" | "error";
}

interface ConnectUIOptions {
  sessionToken: string;
  onEvent: (event: NangoEvent) => void | Promise<void>;
}

interface ConnectUIInstance {
  close: () => void;
}

let internalOnEventCallback:
  | ((event: NangoEvent) => void | Promise<void>)
  | null = null;

export function triggerNangoEvent(event: NangoEvent) {
  if (internalOnEventCallback) {
    return internalOnEventCallback(event);
  }
}

export function clearMockedNango() {
  internalOnEventCallback = null;
  mockedNango.openConnectUI.mockClear();
}

export const mockedNango = {
  openConnectUI: vi.fn((options: ConnectUIOptions): ConnectUIInstance => {
    internalOnEventCallback = options.onEvent;
    return {
      close: vi.fn(),
    };
  }),
};
