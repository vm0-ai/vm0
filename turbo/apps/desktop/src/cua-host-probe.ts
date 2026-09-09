import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CuaEmbeddedRuntime } from "./cua-runtime";

/** Runs in the packaged Electron main, after app.whenReady(). No TCC prompts. */
export async function runCuaHostProbe(
  runtime: CuaEmbeddedRuntime,
  capture: boolean,
  userData: string,
  forced = false,
) {
  try {
    const ready = await runtime.start();
    const readyState = runtime.getState();
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
    const stoppedState = runtime.getState();
    const cleanup = runtime.getCleanupEvidence();
    if (
      !cleanup ||
      cleanup.generation !== ready.generation ||
      !cleanup.exitObserved ||
      (forced
        ? !cleanup.process?.forced ||
          !cleanup.process.guardianExitObserved ||
          !cleanup.process.descendantsExited ||
          cleanup.process.heartbeatCount < 20 ||
          cleanup.process.elapsedMs > 5000
        : !cleanup.exitSuccess ||
          cleanup.exitCode !== 0 ||
          !cleanup.hostStopped) ||
      !cleanup.directoryRemoved ||
      stoppedState.phase !== "stopped" ||
      stoppedState.cleanupPending ||
      stoppedState.generation !== null
    )
      throw new Error("CUA probe did not complete a clean process lifecycle");
    return {
      schemaVersion: 1,
      ...ready,
      readyState,
      stoppedState,
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
      attribution: permissions.attribution,
      capture: permissions.screenshot
        ? "success"
        : capture
          ? "permission_denied"
          : "not_requested",
      cleanup,
    };
  } finally {
    await runtime.dispose();
  }
}
