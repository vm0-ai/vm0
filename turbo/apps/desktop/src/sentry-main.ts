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
  process.env.VM0_DESKTOP_SENTRY_DSN = sentryDsn;
  process.env.VM0_DESKTOP_SENTRY_RELEASE = sentryRelease;
  process.env.VM0_DESKTOP_SENTRY_ENVIRONMENT = sentryEnvironment;

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
    scope.setTags({
      app: "desktop",
      component: "computer-use-helper",
      nativeHelperMode: context.mode,
      nativeHelperStage: context.stage,
      nativeHelperRequestKind: context.requestKind,
    });
    scope.setContext("computerUseHelper", {
      helperPath: context.helperPath,
      exitCode: context.exitCode,
      signal: context.signal,
      stderr: context.stderr,
    });
    Sentry.captureException(error);
  });
}
