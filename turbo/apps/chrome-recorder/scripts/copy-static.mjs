import { copyFile, mkdir } from "node:fs/promises";

const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });

await Promise.all([
  copyFile(
    new URL("../public/manifest.json", import.meta.url),
    new URL("manifest.json", output),
  ),
  copyFile(
    new URL("../public/offscreen.html", import.meta.url),
    new URL("offscreen.html", output),
  ),
  copyFile(
    new URL("../public/handoff.html", import.meta.url),
    new URL("handoff.html", output),
  ),
  copyFile(
    new URL("../../platform/public/icons/icon-192.png", import.meta.url),
    new URL("icon-192.png", output),
  ),
]);
