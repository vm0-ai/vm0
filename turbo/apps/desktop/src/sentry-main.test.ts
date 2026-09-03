import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const scope = {
    setTags: vi.fn(),
    setFingerprint: vi.fn(),
    setContext: vi.fn(),
  };
  return {
    scope,
    init: vi.fn(),
    captureException: vi.fn(),
    withScope: vi.fn((callback: (value: typeof scope) => void) => {
      callback(scope);
    }),
  };
});

vi.mock("@sentry/electron/main", () => ({
  init: mocks.init,
  captureException: mocks.captureException,
  withScope: mocks.withScope,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SENTRY_DSN_DESKTOP", "https://public@example.invalid/1");
  vi.stubEnv("SENTRY_ENVIRONMENT", "test");
  vi.stubEnv("OKOU_DESKTOP_SENTRY_DSN", "");
  vi.stubEnv("OKOU_DESKTOP_SENTRY_RELEASE", "");
  vi.stubEnv("OKOU_DESKTOP_SENTRY_ENVIRONMENT", "");
  vi.stubGlobal("__DESKTOP_VERSION__", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("desktop native helper Sentry classification", () => {
  it("fingerprints the causal exit and tags whether a request was interrupted", async () => {
    const { captureDesktopNativeHelperError } = await import("./sentry-main");
    const error = new Error("runtime terminated");

    captureDesktopNativeHelperError(error, {
      helperPath: "/Applications/Okou.app/helper",
      mode: "serve",
      requestKind: "runtime",
      stage: "exit",
      exitCode: null,
      signal: "SIGTERM",
      terminationReason: "unexpected_exit",
      pendingRequestCount: 1,
      queuedRequestCount: 2,
    });

    expect(mocks.scope.setTags).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nativeHelperTerminationReason: "unexpected_exit",
        nativeHelperSignal: "SIGTERM",
        nativeHelperExitCode: "none",
        nativeHelperImpact: "request_interrupted",
        nativeHelperHasQueuedRequests: true,
      }),
    );
    expect(mocks.scope.setFingerprint).toHaveBeenCalledExactlyOnceWith([
      "{{ default }}",
      "mode:serve",
      "stage:exit",
      "termination:unexpected_exit",
      "signal:SIGTERM",
      "exit:none",
    ]);
    expect(mocks.scope.setContext).toHaveBeenCalledWith(
      "computerUseHelper",
      expect.objectContaining({
        signal: "SIGTERM",
        terminationReason: "unexpected_exit",
        pendingRequestCount: 1,
        queuedRequestCount: 2,
      }),
    );
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(error);
  });
});
