import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";
import {
  ZERO_MIGRATION_BRIDGE_CONFIG,
  isTrustedZeroMigrationDownloadUrl,
  isVersionAtLeast,
} from "./desktop-zero-migration-config";
import type { DesktopZeroMigrationState } from "./desktop-zero-migration-types";

interface ZeroMigrationPreferences {
  readonly deferredUntil: string | null;
  readonly startedAt: string | null;
  readonly lastError: string | null;
}

interface DesktopZeroMigrationControllerOptions {
  readonly enabled: boolean;
  readonly product: "zero" | "okou";
  readonly appVersion: string;
  readonly preferencesPath: string;
  readonly drainAndStopZero: () => Promise<void>;
  readonly startZero: () => Promise<void>;
  readonly openDownload: (url: string) => Promise<void>;
  readonly onChange?: () => void;
  readonly now?: () => number;
}

const PREFERENCE_KEY = "zeroMigration";

function optionalIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
}

function readZeroMigrationPreferences(
  preferencesPath: string,
): ZeroMigrationPreferences {
  const value = readDesktopPreferenceRecord(preferencesPath)[PREFERENCE_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { deferredUntil: null, startedAt: null, lastError: null };
  }
  const record = value as Record<string, unknown>;
  return {
    deferredUntil: optionalIsoDate(record.deferredUntil),
    startedAt: optionalIsoDate(record.startedAt),
    lastError: typeof record.lastError === "string" ? record.lastError : null,
  };
}

function migrationErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Unable to open the Okou download.";
}

export class DesktopZeroMigrationController {
  private readonly enabled: boolean;
  private readonly product: "zero" | "okou";
  private readonly appVersion: string;
  private readonly preferencesPath: string;
  private readonly drainAndStopZero: () => Promise<void>;
  private readonly startZero: () => Promise<void>;
  private readonly openDownload: (url: string) => Promise<void>;
  private readonly onChange: () => void;
  private readonly now: () => number;
  private waitingForCommand = false;

  constructor(options: DesktopZeroMigrationControllerOptions) {
    this.enabled = options.enabled;
    this.product = options.product;
    this.appVersion = options.appVersion;
    this.preferencesPath = options.preferencesPath;
    this.drainAndStopZero = options.drainAndStopZero;
    this.startZero = options.startZero;
    this.openDownload = options.openDownload;
    this.onChange = options.onChange ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  getState(): DesktopZeroMigrationState {
    if (!this.isEligible()) {
      return { mode: "hidden", nextReminderAt: null, errorMessage: null };
    }
    const preferences = readZeroMigrationPreferences(this.preferencesPath);
    if (this.waitingForCommand) {
      return {
        mode: "waiting_for_command",
        nextReminderAt: null,
        errorMessage: null,
      };
    }
    if (preferences.startedAt) {
      return {
        mode: preferences.lastError ? "download_failed" : "paused",
        nextReminderAt: null,
        errorMessage: preferences.lastError,
      };
    }
    if (
      preferences.deferredUntil &&
      Date.parse(preferences.deferredUntil) > this.now()
    ) {
      return {
        mode: "hidden",
        nextReminderAt: preferences.deferredUntil,
        errorMessage: null,
      };
    }
    return {
      mode: "soft_reminder",
      nextReminderAt: null,
      errorMessage: null,
    };
  }

  shouldSuppressAutoStart(): boolean {
    return (
      this.product === "zero" &&
      readZeroMigrationPreferences(this.preferencesPath).startedAt !== null
    );
  }

  shouldOpenWindowOnLaunch(): boolean {
    return this.getState().mode !== "hidden";
  }

  remindLater(): DesktopZeroMigrationState {
    if (!this.isEligible()) {
      return this.getState();
    }
    this.writePreferences({
      deferredUntil: new Date(
        this.now() + ZERO_MIGRATION_BRIDGE_CONFIG.reminderDelayMs,
      ).toISOString(),
      startedAt: null,
      lastError: null,
    });
    this.onChange();
    return this.getState();
  }

  async beginMigration(): Promise<DesktopZeroMigrationState> {
    if (!this.isEligible() || this.waitingForCommand) {
      return this.getState();
    }
    const existing = readZeroMigrationPreferences(this.preferencesPath);
    this.writePreferences({
      deferredUntil: null,
      startedAt: existing.startedAt ?? new Date(this.now()).toISOString(),
      lastError: null,
    });
    this.waitingForCommand = true;
    this.onChange();
    try {
      await this.drainAndStopZero();
      await this.openDownload(ZERO_MIGRATION_BRIDGE_CONFIG.downloadUrl);
    } catch (error) {
      this.writePreferences({
        deferredUntil: null,
        startedAt:
          readZeroMigrationPreferences(this.preferencesPath).startedAt ??
          new Date(this.now()).toISOString(),
        lastError: migrationErrorMessage(error),
      });
    } finally {
      this.waitingForCommand = false;
      this.onChange();
    }
    return this.getState();
  }

  async resumeZero(): Promise<DesktopZeroMigrationState> {
    this.clearPreferences();
    this.onChange();
    await this.startZero();
    return this.getState();
  }

  clearForUserInitiatedStart(): void {
    if (!this.shouldSuppressAutoStart()) {
      return;
    }
    this.clearPreferences();
    this.onChange();
  }

  private isEligible(): boolean {
    return (
      this.enabled &&
      this.product === "zero" &&
      isVersionAtLeast(
        this.appVersion,
        ZERO_MIGRATION_BRIDGE_CONFIG.minimumVersion,
      ) &&
      isTrustedZeroMigrationDownloadUrl(
        ZERO_MIGRATION_BRIDGE_CONFIG.downloadUrl,
      )
    );
  }

  private writePreferences(value: ZeroMigrationPreferences): void {
    const preferences = readDesktopPreferenceRecord(this.preferencesPath);
    writeDesktopPreferenceRecord(this.preferencesPath, {
      ...preferences,
      [PREFERENCE_KEY]: value,
    });
  }

  private clearPreferences(): void {
    const preferences = readDesktopPreferenceRecord(this.preferencesPath);
    delete preferences[PREFERENCE_KEY];
    writeDesktopPreferenceRecord(this.preferencesPath, preferences);
  }
}
