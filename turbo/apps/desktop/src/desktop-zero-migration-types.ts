export type DesktopZeroMigrationMode =
  | "hidden"
  | "soft_reminder"
  | "waiting_for_command"
  | "paused"
  | "download_failed"
  | "hard_stop_waiting"
  | "hard_stop";

export interface DesktopZeroMigrationState {
  readonly mode: DesktopZeroMigrationMode;
  readonly nextReminderAt: string | null;
  readonly errorMessage: string | null;
}
