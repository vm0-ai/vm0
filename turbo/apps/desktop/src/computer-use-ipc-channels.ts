export const COMPUTER_USE_CHANNELS = {
  getState: "computer-use:get-state",
  refreshPermissions: "computer-use:refresh-permissions",
  start: "computer-use:start",
  stop: "computer-use:stop",
  requestAccessibilityPermission: "computer-use:request-accessibility",
  requestScreenRecordingPermission: "computer-use:request-screen-recording",
  setKeepAwakeEnabled: "computer-use:set-keep-awake-enabled",
  openAccessibilitySettings: "computer-use:open-accessibility-settings",
  openScreenRecordingSettings: "computer-use:open-screen-recording-settings",
  changed: "computer-use:changed",
} as const;
