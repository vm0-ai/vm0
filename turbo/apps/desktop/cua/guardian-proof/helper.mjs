import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [sdkPath, binaryPath, socketPath, mode] = process.argv.slice(-4);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function marker(suffix, value) {
  const destination = `${socketPath}.${suffix}`;
  fs.writeFileSync(`${destination}.tmp`, JSON.stringify(value));
  fs.renameSync(`${destination}.tmp`, destination);
}

async function healthy(sdk, host) {
  const connection = await host.start();
  const client = sdk.CuaDriver.connect(connection.socketPath);
  const metadata = await client.metadata();
  if (metadata.pid !== connection.pid || metadata.driverVersion !== "0.23.2")
    throw new Error("real daemon metadata mismatch");
  marker("helper", {
    pid: process.pid,
    parent: process.ppid,
    daemon: metadata.pid,
    electron: process.versions.electron,
    nativeVersion: metadata.driverVersion,
  });
  while (!fs.existsSync(`${socketPath}.fault`)) await pause(5);
  let cancellations = null;
  if (mode === "native-cancel") {
    const requests = Array.from({ length: 64 }, () => {
      const abort = new AbortController();
      const request = client.metadata({ signal: abort.signal });
      abort.abort();
      return request;
    });
    const outcomes = await Promise.allSettled(requests);
    cancellations = {
      attempted: requests.length,
      fulfilled: outcomes.filter((result) => result.status === "fulfilled")
        .length,
      rejected: outcomes.filter((result) => result.status === "rejected")
        .length,
    };
  }
  const exit = host.waitForExit(connection.generation);
  await host.stop();
  const ended = await exit;
  client.uniffiDestroy();
  host.uniffiDestroy();
  marker("graceful", { ended, cancellations });
  process.exit(0);
}

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
      { name: "HOME", value: path.dirname(socketPath) },
    ],
    inheritStderr: false,
    // Match production's AppKit loop. This proof starts no sessions or actions,
    // so its cursor stays off screen and never draws.
    noOverlay: false,
  });
  if (mode === "healthy" || mode === "native-cancel") {
    await healthy(sdk, host);
    return;
  }
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
  marker("helper", {
    pid: process.pid,
    parent: process.ppid,
    stateStarting: host.state() === sdk.EmbeddedDriverHostState.Starting,
    connectionAbsent: host.connection() == null,
    settled,
    electron: process.versions.electron,
  });
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
