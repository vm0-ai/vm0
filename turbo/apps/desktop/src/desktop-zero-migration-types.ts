export type DesktopZeroMigrationMode =
  | "hidden"
  | "soft_reminder"
  | "waiting_for_command"
  | "paused"
  | "download_failed";

export interface DesktopZeroMigrationState {
  readonly mode: DesktopZeroMigrationMode;
  readonly nextReminderAt: string | null;
  readonly errorMessage: string | null;
}
