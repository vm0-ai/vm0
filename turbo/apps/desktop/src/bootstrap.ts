import { app } from "electron";

import { enterDegradedDesktopMode } from "./bootstrap-degraded";
import { resolveDesktopConfig } from "./config";
import { resolveComputerUseApiBaseUrl } from "./desktop-api-base-url";
import { installDesktopAutoUpdates } from "./desktop-auto-updates";
import type { DesktopMainModule } from "./desktop-main-module";

// Crash-resilient entry point (package.json "main"). It owns the auto-updater
// so a fixed release can still be installed when the main bundle fails at
// module-load time. It must stay trivially safe to load: no workspace
// (`@vm0/*`) imports, directly or transitively — guarded by
// bootstrap-imports.test.ts and scripts/check-bootstrap-bundle.mjs.

const config = resolveDesktopConfig();
const apiBaseUrl = resolveComputerUseApiBaseUrl(config.platformUrl);

type DesktopMainLoadResult =
  | { readonly ok: true; readonly main: DesktopMainModule }
  | { readonly ok: false; readonly error: unknown };

function loadDesktopMain(): DesktopMainLoadResult {
  try {
    // Synchronous runtime require keeps main's top-level startup timing
    // unchanged; "./main.js" is external in tsup.electron.config.js so the
    // main bundle is never inlined into this one. The contract cast is
    // enforced at compile time by the typed exports in main.ts.
    return { ok: true, main: require("./main.js") as DesktopMainModule };
  } catch (error) {
    return { ok: false, error };
  }
}

const loaded = loadDesktopMain();

if (loaded.ok) {
  const main = loaded.main;
  void app.whenReady().then(() => {
    main.notifyDesktopAutoUpdatesInstalled(
      installDesktopAutoUpdates({
        config,
        apiBaseUrl,
        ...main.desktopUpdateHooks(),
      }),
    );
  });
} else {
  enterDegradedDesktopMode({ config, apiBaseUrl, error: loaded.error });
}
