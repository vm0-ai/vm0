import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [sdkPath, binaryPath, socketPath, mode] = process.argv.slice(-4);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const sdk = await import(pathToFileURL(sdkPath).href);
  const host = sdk.EmbeddedCuaDriverHost.withOptions({
    binaryPath,
    socketPath,
    hostBundleId: "ai.okou.desktop.quit-proof",
    startupTimeoutMs: 10_000n,
    shutdownTimeoutMs: 2_000n,
    permissionMode: sdk.EmbeddedPermissionMode.Standard,
    approveCapabilityManifest: false,
    approveSessionPolicy: false,
    dangerouslyBypassApprovals: false,
    environment: [
      { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "0" },
      { name: "CUA_TELEMETRY_ENABLED", value: "0" },
    ],
    inheritStderr: false,
    noOverlay: true,
  });
  let settled = false;
  void host.start().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const until = performance.now() + 5_000;
  while (!fs.existsSync(`${socketPath}.daemon`)) {
    if (performance.now() > until) throw new Error("daemon did not start");
    await pause(5);
  }
  fs.writeFileSync(
    `${socketPath}.helper`,
    JSON.stringify({
      pid: process.pid,
      parent: process.ppid,
      stateStarting: host.state() === sdk.EmbeddedDriverHostState.Starting,
      connectionAbsent: host.connection() == null,
      settled,
      electron: process.versions.electron,
    }),
  );
  if (mode === "helper-dies") {
    while (!fs.existsSync(`${socketPath}.fault`)) await pause(5);
    process.kill(process.pid, "SIGKILL");
  }
  // Real blocked execution. The independent rescue is outside the proof bound.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000);
  process.kill(process.pid, "SIGKILL");
}

void main().catch((error) => {
  fs.writeFileSync(`${socketPath}.error`, error.stack);
  process.kill(process.pid, "SIGKILL");
});
