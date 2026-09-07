import type { DesktopComputerUseDriverState } from "../computer-use-types";

/** External bridge baseline for renderer, IPC and tray test entry points. */
export const stoppedOkouDriverState: DesktopComputerUseDriverState = {
  experimentalCuaEnabled: false,
  selectedDriver: "okou",
  developerAvailability: "unavailable",
  actual: null,
  phase: "stopped",
  lifecycleElapsedMs: 0,
  cleanupPending: false,
  expectedCuaVersion: "0.23.2",
  error: null,
  canRetry: true,
};
