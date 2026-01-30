import { act, render } from "@testing-library/react";
import type { TestContext } from "../signals/__tests__/test-helpers";
import { clearMockedAuth, mockUser } from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import {
  mockPushState,
  pushState,
  setPathname,
  setSearch,
} from "../signals/location";
import { vi } from "vitest";
import type { FeatureSwitchKey } from "@vm0/core";
import { setFeatureSwitchLocalStorage$ } from "../signals/external/feature-switch";
import { setDebugLoggerLocalStorage$ } from "../signals/bootstrap/loggers";

export async function setupPage(options: {
  context: TestContext;
  path: string;
  user?: { id: string; fullName: string } | null;
  session?: { token: string } | null;
  debugLoggers?: string[];
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
}) {
  createPushStateMock(options.context.signal);
  pushState({}, "", options.path);

  if (options.debugLoggers) {
    options.context.store.set(
      setDebugLoggerLocalStorage$,
      JSON.stringify(options.debugLoggers ?? []),
    );
  }

  if (options.featureSwitches) {
    options.context.store.set(
      setFeatureSwitchLocalStorage$,
      JSON.stringify(options.featureSwitches),
    );
  }

  mockUser(
    options.user !== undefined
      ? options.user
      : {
          id: "test-user-123",
          fullName: "Test User",
        },
    options.session ?? {
      token: "test-token",
    },
  );
  options.context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });

  // Bootstrap the app (like main.ts does)
  await act(async () => {
    await options.context.store.set(
      bootstrap$,
      () => {
        setupRouter(options.context.store, (element) => {
          const { unmount } = render(element);
          options.context.signal.addEventListener("abort", () => {
            unmount();
          });
        });
      },
      options.context.signal,
    );
  });
}

// Helper to create a pushState mock that updates mockLocation
export function createPushStateMock(signal: AbortSignal) {
  const fn = vi.fn(
    (_data: unknown, _unused: string, url?: string | URL | null) => {
      if (typeof url === "string") {
        const urlObj = new URL(url, "http://localhost");
        setPathname(urlObj.pathname);
        setSearch(urlObj.search);
      }
    },
  ) as unknown as typeof window.history.pushState;
  mockPushState(fn, signal);
  return fn;
}
