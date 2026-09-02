export const DESKTOP_RECORDER_CHANNELS = {
  getState: "desktop-recorder:get-state",
  getCapabilities: "desktop-recorder:get-capabilities",
  openScreenRecordingSettings:
    "desktop-recorder:open-screen-recording-settings",
  startCapture: "desktop-recorder:start-capture",
  beginAreaSelection: "desktop-recorder:begin-area-selection",
  completeAreaSelection: "desktop-recorder:complete-area-selection",
  selectWindow: "desktop-recorder:select-window",
  listWindowOptions: "desktop-recorder:list-window-options",
  completeWindowSelection: "desktop-recorder:complete-window-selection",
  pause: "desktop-recorder:pause",
  resume: "desktop-recorder:resume",
  discard: "desktop-recorder:discard",
  stop: "desktop-recorder:stop",
  cancel: "desktop-recorder:cancel",
} as const;
