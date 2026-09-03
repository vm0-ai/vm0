import * as Sentry from "@sentry/electron/main";
import type { ComputerUseNativeRuntimeErrorContext } from "./computer-use-native";

declare const __DESKTOP_VERSION__: string;
declare const __DESKTOP_SENTRY_DSN__: string;
declare const __DESKTOP_SENTRY_ENVIRONMENT__: string;

const sentryDsn = process.env.SENTRY_DSN_DESKTOP ?? __DESKTOP_SENTRY_DSN__;
const sentryRelease = `desktop@${__DESKTOP_VERSION__}`;
const sentryEnvironment =
  process.env.SENTRY_ENVIRONMENT ?? __DESKTOP_SENTRY_ENVIRONMENT__;

if (sentryDsn) {
  process.env.OKOU_DESKTOP_SENTRY_DSN = sentryDsn;
  process.env.OKOU_DESKTOP_SENTRY_RELEASE = sentryRelease;
  process.env.OKOU_DESKTOP_SENTRY_ENVIRONMENT = sentryEnvironment;

  Sentry.init({
    dsn: sentryDsn,
    release: sentryRelease,
    environment: sentryEnvironment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    attachScreenshot: false,
    initialScope: {
      tags: {
        app: "desktop",
        component: "electron-main",
      },
    },
  });
}

export function captureDesktopNativeHelperError(
  error: Error,
  context: ComputerUseNativeRuntimeErrorContext,
): void {
  if (!sentryDsn) {
    return;
  }

  Sentry.withScope((scope) => {
    const pendingRequestCount = context.pendingRequestCount ?? 0;
    const queuedRequestCount = context.queuedRequestCount ?? 0;
    const impact =
      pendingRequestCount > 0 ? "request_interrupted" : "no_active_request";
    scope.setTags({
      app: "desktop",
      component: "computer-use-helper",
      nativeHelperMode: context.mode,
      nativeHelperStage: context.stage,
      nativeHelperRequestKind: context.requestKind,
      nativeHelperTerminationReason:
        context.terminationReason ?? "not_applicable",
      nativeHelperSignal: context.signal ?? "none",
      nativeHelperExitCode: context.exitCode ?? "none",
      nativeHelperImpact: impact,
      nativeHelperHasQueuedRequests: queuedRequestCount > 0,
    });
    scope.setFingerprint([
      "{{ default }}",
      `mode:${context.mode}`,
      `stage:${context.stage}`,
      `termination:${context.terminationReason ?? "not_applicable"}`,
      `signal:${context.signal ?? "none"}`,
      `exit:${context.exitCode ?? "none"}`,
    ]);
    scope.setContext("computerUseHelper", {
      helperPath: context.helperPath,
      exitCode: context.exitCode,
      signal: context.signal,
      stderr: context.stderr,
      terminationReason: context.terminationReason,
      pendingRequestCount: context.pendingRequestCount,
      queuedRequestCount: context.queuedRequestCount,
    });
    Sentry.captureException(error);
  });
}
