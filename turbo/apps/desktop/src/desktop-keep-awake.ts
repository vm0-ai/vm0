import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DesktopKeepAwakeState } from "./computer-use-types";

const KEEP_AWAKE_BLOCKER_TYPE = "prevent-app-suspension";

export interface DesktopKeepAwakeBlocker {
  readonly start: (type: typeof KEEP_AWAKE_BLOCKER_TYPE) => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

interface DesktopKeepAwakeControllerOptions {
  readonly preferencesPath: string;
  readonly blocker: DesktopKeepAwakeBlocker;
  readonly onChange: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPreferenceRecord(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function readKeepAwakeEnabled(filePath: string): boolean {
  const value = readPreferenceRecord(filePath).keepAwakeEnabled;
  return typeof value === "boolean" ? value : false;
}

function writeKeepAwakeEnabled(filePath: string, enabled: boolean): void {
  const preferences = readPreferenceRecord(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ ...preferences, keepAwakeEnabled: enabled }, null, 2)}\n`,
    "utf8",
  );
}

export class DesktopKeepAwakeController {
  private readonly options: DesktopKeepAwakeControllerOptions;
  private enabled = false;
  private blockerId: number | null = null;

  constructor(options: DesktopKeepAwakeControllerOptions) {
    this.options = options;
  }

  load(): DesktopKeepAwakeState {
    this.enabled = readKeepAwakeEnabled(this.options.preferencesPath);
    this.apply();
    return this.getState();
  }

  getState(): DesktopKeepAwakeState {
    return {
      enabled: this.enabled,
      active: this.isActive(),
    };
  }

  setEnabled(enabled: boolean): DesktopKeepAwakeState {
    const previous = this.getState();
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      writeKeepAwakeEnabled(this.options.preferencesPath, enabled);
    }
    this.apply();
    return this.notifyIfChanged(previous);
  }

  release(): DesktopKeepAwakeState {
    const previous = this.getState();
    this.stopBlocker();
    return this.notifyIfChanged(previous);
  }

  private apply(): void {
    if (this.enabled) {
      this.startBlocker();
      return;
    }
    this.stopBlocker();
  }

  private startBlocker(): void {
    if (this.isActive()) {
      return;
    }
    this.blockerId = this.options.blocker.start(KEEP_AWAKE_BLOCKER_TYPE);
  }

  private stopBlocker(): void {
    const blockerId = this.blockerId;
    this.blockerId = null;
    if (blockerId !== null && this.options.blocker.isStarted(blockerId)) {
      this.options.blocker.stop(blockerId);
    }
  }

  private isActive(): boolean {
    return (
      this.blockerId !== null && this.options.blocker.isStarted(this.blockerId)
    );
  }

  private notifyIfChanged(
    previous: DesktopKeepAwakeState,
  ): DesktopKeepAwakeState {
    const next = this.getState();
    if (previous.enabled !== next.enabled || previous.active !== next.active) {
      this.options.onChange();
    }
    return next;
  }
}
