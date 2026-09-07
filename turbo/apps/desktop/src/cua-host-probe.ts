import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CuaEmbeddedRuntime } from "./cua-runtime";

/** Runs in the packaged Electron main, after app.whenReady(). No TCC prompts. */
export async function runCuaHostProbe(
  runtime: CuaEmbeddedRuntime,
  capture: boolean,
  userData: string,
) {
  try {
    const ready = await runtime.start();
    const permissions = await runtime.probe(capture);
    if (permissions.screenshot) {
      const directory = path.join(userData, "cua-host-probe");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(directory, "screenshot.png"),
        Buffer.from(permissions.screenshot, "base64"),
        { mode: 0o600 },
      );
    }
    await runtime.stop();
    return {
      ...ready,
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
      attribution: permissions.attribution,
      capture: permissions.screenshot
        ? "success"
        : capture
          ? "permission_denied"
          : "not_requested",
      cleanup: "confirmed",
    };
  } finally {
    await runtime.dispose();
  }
}
