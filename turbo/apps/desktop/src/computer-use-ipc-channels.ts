export const COMPUTER_USE_CHANNELS = {
  getState: "computer-use:get-state",
  refreshPermissions: "computer-use:refresh-permissions",
  start: "computer-use:start",
  requestAccessibilityPermission: "computer-use:request-accessibility",
  requestScreenRecordingPermission: "computer-use:request-screen-recording",
  openAccessibilitySettings: "computer-use:open-accessibility-settings",
  openScreenRecordingSettings: "computer-use:open-screen-recording-settings",
  changed: "computer-use:changed",
} as const;
