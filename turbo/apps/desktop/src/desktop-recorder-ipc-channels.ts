export const DESKTOP_RECORDER_CHANNELS = {
  getState: "desktop-recorder:get-state",
  listSources: "desktop-recorder:list-sources",
  startCapture: "desktop-recorder:start-capture",
  selectArea: "desktop-recorder:select-area",
  pause: "desktop-recorder:pause",
  resume: "desktop-recorder:resume",
  discard: "desktop-recorder:discard",
  stop: "desktop-recorder:stop",
  cancel: "desktop-recorder:cancel",
  completeAreaSelection: "desktop-recorder:complete-area-selection",
} as const;
