import type { ComputerUseHostRuntimeState } from "./computer-use-types";

// Contract between the bootstrap entry and the main bundle. The bootstrap
// loads `./main.js` at runtime, so this contract is enforced at compile time
// by the typed exports in `main.ts` rather than by a runtime check.

export interface DesktopUpdateHooks {
  readonly getComputerUseHostState: () => ComputerUseHostRuntimeState;
  readonly prepareForQuitAndInstall: () => Promise<void>;
}

export interface DesktopMainModule {
  readonly desktopUpdateHooks: () => DesktopUpdateHooks;
  readonly notifyDesktopAutoUpdatesInstalled: (installed: boolean) => void;
}
