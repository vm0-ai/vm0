import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { app } from "electron";
const loadAddon = createRequire(import.meta.url);
const [build, sdkPath, socketPath, mode, daemonPath] = process.argv.slice(-5);
app.commandLine.appendSwitch("disable-gpu");

void app.whenReady().then(async () => {
  const owner = loadAddon(path.join(build, "owner.node"));
  const guardian = owner.launch([
    path.join(build, "guardian"),
    process.execPath,
    fileURLToPath(new URL("./helper.mjs", import.meta.url)),
    sdkPath,
    daemonPath,
    socketPath,
    mode,
  ]);
  fs.writeFileSync(
    `${socketPath}.main.tmp`,
    JSON.stringify({
      pid: process.pid,
      guardian,
      electron: process.versions.electron,
      node: process.versions.node,
    }),
  );
  fs.renameSync(`${socketPath}.main.tmp`, `${socketPath}.main`);
  let beats = 0;
  const heartbeat = setInterval(() => {
    ++beats;
    owner.pulse();
  }, 10);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (mode !== "spawn-stop") {
    const until = performance.now() + 6_000;
    while (!fs.existsSync(`${socketPath}.fault`)) {
      if (performance.now() > until) throw new Error("observer did not arm");
      await pause(5);
    }
  }
  const started = performance.now();
  // Ownership and the single total deadline precede any native cleanup.
  const deadline = started + 5_000;
  const beginningBeats = beats;
  const samples = [];
  let signalResult = null;
  let crashSample = null;
  let fenceRetained = false;
  if (mode === "main-dies") process.kill(process.pid, "SIGKILL");
  if (mode === "main-dies-during-force") {
    owner.force(guardian);
    process.kill(process.pid, "SIGKILL");
  }
  if (mode === "guardian-dies") {
    owner.crashGuardian();
    // Let libuv run repeatedly; this must not reap the unregistered child.
    await pause(200);
    crashSample = owner.sample();
  }
  if (mode === "guardian-stops") {
    if (owner.stopGuardian() !== 0) throw new Error("guardian stop failed");
    await pause(200);
    crashSample = owner.sample();
  }
  if (mode === "identity-mismatch") {
    signalResult = owner.force(guardian + 1);
  }
  const noForce = ["failed-kill", "identity-mismatch"].includes(mode);
  let signals = 0;
  let confirmed = false;
  while (performance.now() < deadline) {
    const elapsed = performance.now() - started;
    if (!noForce && (elapsed >= 3_000 || mode === "spawn-stop")) {
      ++signals;
      signalResult = owner.force(guardian);
    }
    const state = owner.sample();
    if (samples.length === 0 || elapsed >= samples.length * 500)
      samples.push({ elapsed, ...state });
    if (
      mode !== "lost-observation" &&
      state.exited &&
      state.waitError === 0 &&
      state.remaining === 0
    ) {
      owner.reap();
      confirmed = true;
      break;
    }
    await pause(10);
  }
  const elapsedMs = performance.now() - started;
  if (!confirmed) {
    try {
      owner.launch([]);
    } catch (error) {
      fenceRetained = error.message.includes("ownership fence");
    }
  }
  fs.writeFileSync(
    `${socketPath}.result`,
    JSON.stringify(
      {
        mode,
        confirmed,
        cleanup: confirmed ? "confirmed" : "cleanup_unproven",
        elapsedMs,
        beats: beats - beginningBeats,
        signalResult,
        signals,
        crashSample,
        fenceRetained,
        samples,
      },
      null,
      2,
    ),
  );
  if (!confirmed) {
    // Separate diagnostic rescue, never counted as successful retirement.
    const rescueUntil = performance.now() + 2_000;
    while (performance.now() < rescueUntil) {
      owner.force(guardian);
      const state = owner.sample();
      if (state.exited && state.waitError === 0 && state.remaining === 0) {
        owner.reap();
        break;
      }
      await pause(10);
    }
  }
  clearInterval(heartbeat);
  app.exit(0);
});
