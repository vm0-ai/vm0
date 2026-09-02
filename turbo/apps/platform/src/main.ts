import { scheduleIOSPWAStartupImages } from "./lib/ios-pwa-startup-image.ts";
import { startPlatformEntrypoint } from "./lib/platform-entrypoint.ts";

startPlatformEntrypoint();
scheduleIOSPWAStartupImages();
