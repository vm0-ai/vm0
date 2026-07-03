import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";

import type { DesktopConfig } from "./config";
import { OFFLINE_COMPUTER_USE_HOST_STATE } from "./computer-use-types";
import { installDesktopAutoUpdates } from "./desktop-auto-updates";

// Degraded mode runs when the main bundle fails to load, so this module must
// stay loadable by the bootstrap entry: no workspace (`@vm0/*`) imports.

declare const __DESKTOP_VERSION__: string | undefined;
declare const __DESKTOP_SENTRY_DSN__: string | undefined;
declare const __DESKTOP_SENTRY_ENVIRONMENT__: string | undefined;

const BOOTSTRAP_FAILURE_LOG_FILE = "desktop-bootstrap-failure.log";

interface BootstrapSentry {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown): string;
}

// The `typeof` guards keep this module loadable under vitest, where the tsup
// compile-time defines are absent.
function bundledSentryDsn(): string {
  return typeof __DESKTOP_SENTRY_DSN__ === "string"
    ? __DESKTOP_SENTRY_DSN__
    : "";
}

function bundledSentryEnvironment(): string {
  return typeof __DESKTOP_SENTRY_ENVIRONMENT__ === "string"
    ? __DESKTOP_SENTRY_ENVIRONMENT__
    : "";
}

function bundledVersion(): string {
  return typeof __DESKTOP_VERSION__ === "string" ? __DESKTOP_VERSION__ : "";
}

function describeBootstrapError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function loadBootstrapSentry(): Promise<BootstrapSentry | null> {
  try {
    return await import("@sentry/electron/main");
  } catch (error) {
    console.error("Desktop bootstrap Sentry load failed", error);
    return null;
  }
}

function writeBootstrapFailureLog(error: unknown): void {
  try {
    const logPath = join(app.getPath("logs"), BOOTSTRAP_FAILURE_LOG_FILE);
    appendFileSync(
      logPath,
      `${new Date().toISOString()} ${describeBootstrapError(error)}\n`,
    );
  } catch (logError) {
    console.error("Desktop bootstrap failure log write failed", logError);
  }
}

async function reportDesktopBootstrapFailure(error: unknown): Promise<void> {
  console.error("Desktop main module failed to load", error);

  const sentryDsn = process.env.SENTRY_DSN_DESKTOP ?? bundledSentryDsn();
  const sentry = sentryDsn ? await loadBootstrapSentry() : null;
  if (!sentry) {
    writeBootstrapFailureLog(error);
    return;
  }

  sentry.init({
    dsn: sentryDsn,
    release: `desktop@${bundledVersion()}`,
    environment: process.env.SENTRY_ENVIRONMENT ?? bundledSentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    attachScreenshot: false,
    initialScope: {
      tags: {
        app: "desktop",
        component: "electron-bootstrap",
      },
    },
  });
  sentry.captureException(error);
}

async function showDegradedStartupDialog(
  autoUpdatesInstalled: boolean,
): Promise<void> {
  await dialog.showMessageBox({
    type: "error",
    buttons: ["OK"],
    defaultId: 0,
    title: "Startup Error",
    message: "Zero Computer Use hit an error during startup.",
    detail: autoUpdatesInstalled
      ? "Keep the app running: a fixed update will be downloaded and installed automatically as soon as it is available."
      : "Please reinstall the latest version of Zero Computer Use.",
  });
}

export function enterDegradedDesktopMode(options: {
  readonly config: DesktopConfig;
  readonly apiBaseUrl: string;
  readonly error: unknown;
}): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  void app.whenReady().then(async () => {
    // No hooks from the main bundle in degraded mode: report an idle host so
    // a downloaded update installs and relaunches without prompting.
    const autoUpdatesInstalled = installDesktopAutoUpdates({
      config: options.config,
      apiBaseUrl: options.apiBaseUrl,
      getComputerUseHostState: () => OFFLINE_COMPUTER_USE_HOST_STATE,
      prepareForQuitAndInstall: async () => {},
    });
    await reportDesktopBootstrapFailure(options.error);
    await showDegradedStartupDialog(autoUpdatesInstalled);
  });
}
