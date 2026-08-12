import {
  desktopZeroMigrationPolicySchema,
  type DesktopZeroMigrationRolloutMode,
} from "@vm0/api-contracts/contracts/desktop-updates";
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
  readonly fetchPolicy: (signal: AbortSignal) => Promise<Response>;
  readonly quitZero: () => void;
  readonly onChange?: () => void;
  readonly onAttention?: () => void;
  readonly logPolicyError?: (error: unknown) => void;
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

function hardStopErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? `Unable to stop Zero safely: ${error.message}`
    : "Unable to stop Zero safely.";
}

export class DesktopZeroMigrationController {
  private readonly enabled: boolean;
  private readonly product: "zero" | "okou";
  private readonly appVersion: string;
  private readonly preferencesPath: string;
  private readonly drainAndStopZero: () => Promise<void>;
  private readonly startZero: () => Promise<void>;
  private readonly openDownload: (url: string) => Promise<void>;
  private readonly fetchPolicy: (signal: AbortSignal) => Promise<Response>;
  private readonly quitZeroApp: () => void;
  private readonly onChange: () => void;
  private readonly onAttention: () => void;
  private readonly logPolicyError: (error: unknown) => void;
  private readonly now: () => number;
  private waitingForCommand = false;
  private hardStopWaiting = false;
  private hardStopError: string | null = null;
  private rolloutMode: DesktopZeroMigrationRolloutMode = "soft";
  private policyRefresh: Promise<DesktopZeroMigrationRolloutMode> | null = null;

  constructor(options: DesktopZeroMigrationControllerOptions) {
    this.enabled = options.enabled;
    this.product = options.product;
    this.appVersion = options.appVersion;
    this.preferencesPath = options.preferencesPath;
    this.drainAndStopZero = options.drainAndStopZero;
    this.startZero = options.startZero;
    this.openDownload = options.openDownload;
    this.fetchPolicy = options.fetchPolicy;
    this.quitZeroApp = options.quitZero;
    this.onChange = options.onChange ?? (() => {});
    this.onAttention = options.onAttention ?? (() => {});
    this.logPolicyError = options.logPolicyError ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  getState(): DesktopZeroMigrationState {
    if (!this.isEligible()) {
      return { mode: "hidden", nextReminderAt: null, errorMessage: null };
    }
    if (this.rolloutMode === "hard") {
      return {
        mode: this.hardStopWaiting ? "hard_stop_waiting" : "hard_stop",
        nextReminderAt: null,
        errorMessage: this.hardStopError,
      };
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
    if (this.rolloutMode === "off") {
      return { mode: "hidden", nextReminderAt: null, errorMessage: null };
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
      (this.rolloutMode === "hard" ||
        readZeroMigrationPreferences(this.preferencesPath).startedAt !== null)
    );
  }

  allowUserInitiatedStart(): boolean {
    return this.rolloutMode !== "hard";
  }

  shouldOpenWindowOnLaunch(): boolean {
    return this.getState().mode !== "hidden";
  }

  remindLater(): DesktopZeroMigrationState {
    if (!this.isEligible() || this.rolloutMode !== "soft") {
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
    if (
      !this.isEligible() ||
      this.rolloutMode === "off" ||
      this.waitingForCommand ||
      this.hardStopWaiting
    ) {
      return this.getState();
    }
    if (this.rolloutMode === "hard") {
      this.hardStopWaiting = true;
      this.hardStopError = null;
      this.onChange();
      try {
        await this.drainAndStopZero();
        await this.openDownload(ZERO_MIGRATION_BRIDGE_CONFIG.downloadUrl);
      } catch (error) {
        this.hardStopError = migrationErrorMessage(error);
      } finally {
        this.hardStopWaiting = false;
        this.onChange();
      }
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
    if (this.rolloutMode === "hard") {
      return this.getState();
    }
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

  quitZero(): DesktopZeroMigrationState {
    if (this.isEligible() && this.rolloutMode === "hard") {
      this.quitZeroApp();
    }
    return this.getState();
  }

  refreshPolicy(): Promise<DesktopZeroMigrationRolloutMode> {
    if (!this.isEligible()) {
      return Promise.resolve(this.rolloutMode);
    }
    this.policyRefresh ??= this.fetchAndApplyPolicy().finally(() => {
      this.policyRefresh = null;
    });
    return this.policyRefresh;
  }

  private async fetchAndApplyPolicy(): Promise<DesktopZeroMigrationRolloutMode> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, ZERO_MIGRATION_BRIDGE_CONFIG.policyRequestTimeoutMs);
    let mode: DesktopZeroMigrationRolloutMode = "soft";
    try {
      const response = await this.fetchPolicy(abortController.signal);
      if (!response.ok) {
        throw new Error(`Migration policy returned HTTP ${response.status}`);
      }
      const parsed = desktopZeroMigrationPolicySchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new Error("Migration policy response is invalid");
      }
      mode = parsed.data.mode;
    } catch (error) {
      this.logPolicyError(error);
    } finally {
      clearTimeout(timeout);
    }
    await this.applyRolloutMode(mode);
    return mode;
  }

  private async applyRolloutMode(
    mode: DesktopZeroMigrationRolloutMode,
  ): Promise<void> {
    const previousMode = this.rolloutMode;
    const shouldDrainHardStop =
      previousMode !== "hard" || this.hardStopError !== null;
    this.rolloutMode = mode;
    this.hardStopError = null;

    if (mode === "hard") {
      if (!shouldDrainHardStop) {
        return;
      }
      this.hardStopWaiting = true;
      if (previousMode !== "hard") {
        this.onAttention();
      }
      this.onChange();
      try {
        await this.drainAndStopZero();
      } catch (error) {
        this.hardStopError = hardStopErrorMessage(error);
      } finally {
        this.hardStopWaiting = false;
        this.onChange();
      }
      return;
    }

    this.hardStopWaiting = false;
    this.onChange();
    if (
      previousMode === "hard" &&
      readZeroMigrationPreferences(this.preferencesPath).startedAt === null
    ) {
      try {
        await this.startZero();
      } catch (error) {
        this.logPolicyError(error);
      }
    }
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
