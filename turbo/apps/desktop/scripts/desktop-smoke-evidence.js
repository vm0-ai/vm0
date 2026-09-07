const manifest = require("../cua/artifacts.json");
const packageMetadata = require("../package.json");

function requireEvidence(condition) {
  if (!condition) throw new Error("invalid_packaged_evidence");
}

function keys(value, expected) {
  requireEvidence(value && typeof value === "object" && !Array.isArray(value));
  requireEvidence(Object.keys(value).sort().join() === expected.sort().join());
}

function dormantDriver(driver) {
  keys(driver, [
    "experimentalCuaEnabled",
    "selectedDriver",
    "developerAvailability",
    "actual",
    "phase",
    "lifecycleElapsedMs",
    "cleanupPending",
    "expectedCuaVersion",
    "error",
    "canRetry",
  ]);
  requireEvidence(
    driver.experimentalCuaEnabled === false && driver.selectedDriver === "okou",
  );
  requireEvidence(
    ["unresolved", "unavailable"].includes(driver.developerAvailability),
  );
  requireEvidence(
    driver.phase === "stopped" &&
      driver.cleanupPending === false &&
      driver.error === null,
  );
  requireEvidence(
    driver.expectedCuaVersion === manifest.driverVersion &&
      typeof driver.canRetry === "boolean",
  );
  requireEvidence(
    Number.isSafeInteger(driver.lifecycleElapsedMs) &&
      driver.lifecycleElapsedMs >= 0 &&
      driver.lifecycleElapsedMs <= 120_000,
  );
  if (driver.actual !== null) {
    keys(driver.actual, ["id", "generation", "version"]);
    requireEvidence(
      driver.actual.id === "okou" && driver.actual.version === null,
    );
    requireEvidence(
      Number.isSafeInteger(driver.actual.generation) &&
        driver.actual.generation > 0,
    );
  }
}

function runtimeState(state, generation, phase) {
  keys(state, [
    "phase",
    "cleanupPending",
    "generation",
    "driverVersion",
    "loadedDriverVersion",
    "error",
  ]);
  requireEvidence(
    state.phase === phase &&
      state.generation === generation &&
      state.cleanupPending === false &&
      state.error === null,
  );
  requireEvidence(state.driverVersion === manifest.driverVersion);
  requireEvidence(
    state.loadedDriverVersion ===
      (phase === "ready" ? manifest.driverVersion : null),
  );
}

/** Parse only the one bounded metadata record from the actual child process. */
function readDesktopSmokeEvidence(stdout, cuaProbe, identity) {
  const prefix = cuaProbe ? "[cua-probe] " : "[smoke-test] evidence ";
  const records = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix));
  requireEvidence(records.length === 1 && records[0].length <= 8192);
  const evidence = JSON.parse(records[0].slice(prefix.length));
  const common = [
    "schemaVersion",
    "desktopVersion",
    "electronVersion",
    "bundleId",
  ];
  keys(evidence, [
    ...common,
    ...(cuaProbe
      ? [
          "generation",
          "driverVersion",
          "metadata",
          "readyState",
          "stoppedState",
          "accessibility",
          "screenRecording",
          "attribution",
          "capture",
          "cleanup",
        ]
      : ["bridge", "sdkLoadAttempted"]),
  ]);
  requireEvidence(
    evidence.schemaVersion === 1 &&
      evidence.desktopVersion === packageMetadata.version,
  );
  requireEvidence(
    evidence.electronVersion === packageMetadata.devDependencies.electron &&
      evidence.bundleId === identity.bundleId,
  );
  if (cuaProbe) validateProbeEvidence(evidence, identity);
  else validateDormantEvidence(evidence, identity);
  return evidence;
}

function validateDormantEvidence(evidence, identity) {
  const bridge = evidence.bridge;
  keys(bridge, [
    "auth",
    "authCompletionRejected",
    "computerUse",
    "developerTools",
    "driverControls",
    "driver",
    "settledDriver",
    "identity",
  ]);
  requireEvidence(
    bridge.auth === true &&
      bridge.authCompletionRejected === true &&
      bridge.computerUse === true &&
      bridge.developerTools === true &&
      bridge.driverControls === true,
  );
  keys(bridge.identity, ["product", "brandName", "displayName"]);
  requireEvidence(
    ["product", "brandName", "displayName"].every(
      (key) => bridge.identity[key] === identity[key],
    ),
  );
  dormantDriver(bridge.driver);
  dormantDriver(bridge.settledDriver);
  requireEvidence(evidence.sdkLoadAttempted === false);
}

function validateProbeEvidence(evidence, identity) {
  requireEvidence(
    Number.isSafeInteger(evidence.generation) &&
      evidence.generation > 0 &&
      evidence.driverVersion === manifest.driverVersion,
  );
  const metadata = evidence.metadata;
  keys(metadata, [
    "pid",
    "embedded",
    "hostBundleId",
    "driverVersion",
    "contractVersion",
    "mcpProtocolVersion",
  ]);
  requireEvidence(
    Number.isSafeInteger(metadata.pid) &&
      metadata.pid > 0 &&
      metadata.embedded === true,
  );
  requireEvidence(
    metadata.hostBundleId === identity.bundleId &&
      metadata.driverVersion === manifest.driverVersion,
  );
  for (const version of [
    metadata.contractVersion,
    metadata.mcpProtocolVersion,
  ]) {
    requireEvidence(
      typeof version === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(version),
    );
  }
  runtimeState(evidence.readyState, evidence.generation, "ready");
  runtimeState(evidence.stoppedState, null, "stopped");
  requireEvidence(
    typeof evidence.accessibility === "boolean" &&
      typeof evidence.screenRecording === "boolean",
  );
  requireEvidence(
    evidence.attribution === "host" && evidence.capture === "not_requested",
  );
  const cleanup = evidence.cleanup;
  keys(cleanup, [
    "generation",
    "exitObserved",
    "exitSuccess",
    "exitCode",
    "hostStopped",
    "directoryRemoved",
  ]);
  requireEvidence(
    cleanup.generation === evidence.generation &&
      cleanup.exitObserved === true &&
      cleanup.exitSuccess === true &&
      cleanup.exitCode === 0 &&
      cleanup.hostStopped === true &&
      cleanup.directoryRemoved === true,
  );
}

module.exports = { readDesktopSmokeEvidence };
