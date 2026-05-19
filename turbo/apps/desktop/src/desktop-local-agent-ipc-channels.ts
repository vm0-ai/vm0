export const DESKTOP_LOCAL_AGENT_CHANNELS = {
  setEnabled: "desktop-local-agent:set-enabled",
  list: "desktop-local-agent:list",
  detectBackends: "desktop-local-agent:detect-backends",
  add: "desktop-local-agent:add",
  start: "desktop-local-agent:start",
  stop: "desktop-local-agent:stop",
  remove: "desktop-local-agent:remove",
  openFolder: "desktop-local-agent:open-folder",
  changed: "desktop-local-agent:changed",
} as const;
