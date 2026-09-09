import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { app } from "electron";
import { z } from "zod";
import { CuaEmbeddedRuntime } from "../../src/cua-runtime";

const execute = promisify(execFile);
const directory = process.argv.at(-1);
if (!directory || !path.isAbsolute(directory))
  throw new Error("Missing absolute discovery proof directory");
const requestedOutput = directory;
const register =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const fixtureSchema = z.object({ bundleId: z.string(), fixture: z.string() });
const identitySchema = z.object({
  bundleId: z.string(),
  pid: z.number().int().positive(),
});
const inventorySchema = z.object({
  apps: z.array(
    z.object({
      bundle_id: z.string().nullable(),
      running: z.boolean(),
      pid: z.number().int().nonnegative(),
    }),
  ),
});
app.commandLine.appendSwitch("disable-gpu");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
}

async function until<T>(
  label: string,
  sample: () => Promise<T | undefined>,
): Promise<T> {
  const expires = performance.now() + 8_000;
  while (performance.now() < expires) {
    const result = await sample();
    if (result !== undefined) return result;
    await pause(100);
  }
  throw new Error(`${label} did not become observable within eight seconds`);
}

async function prove() {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(process.versions.electron, "42.5.1");
  const output = await realpath(requestedOutput);
  const fixture = fixtureSchema.parse(
    JSON.parse(await readFile(path.join(output, "fixture.json"), "utf8")),
  );
  assert.equal(fixture.fixture, path.join(output, "DiscoveryFixture.app"));
  assert.match(fixture.bundleId, /^ai\.okou\.discovery-proof\.[a-f0-9-]+$/);
  const runtime = new CuaEmbeddedRuntime({
    runtimeRoot: path.join(output, "cua"),
    hostBundleId: "ai.okou.desktop",
  });
  const stopFile = path.join(output, "fixture-stop");
  const runningFile = path.join(output, "fixture-running.json");
  const observations: Record<string, unknown>[] = [];
  let fixturePid: number | undefined;
  let failure: unknown;

  async function nativePids() {
    const { stdout } = await execute(
      path.join(fixture.fixture, "Contents/MacOS/fixture"),
      ["--running"],
      { timeout: 5_000 },
    );
    return z.array(z.number().int().positive()).parse(JSON.parse(stdout));
  }

  async function launched(previousPid?: number) {
    fixturePid = await until("fixture startup", async () => {
      const text = await readFile(runningFile, "utf8").catch(
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        },
      );
      if (text === null) return undefined;
      const identity = identitySchema.parse(JSON.parse(text));
      assert.equal(identity.bundleId, fixture.bundleId);
      return identity.pid !== previousPid && alive(identity.pid)
        ? identity.pid
        : undefined;
    });
    return fixturePid;
  }

  async function stopFixture() {
    await writeFile(stopFile, "stop\n");
    const pid = fixturePid;
    await until("fixture process exit", async () =>
      (await nativePids()).length === 0 && (pid === undefined || !alive(pid))
        ? true
        : undefined,
    );
    fixturePid = undefined;
  }

  async function prepareLaunch() {
    await rm(stopFile, { force: true });
    await rm(runningFile, { force: true });
  }

  try {
    await execute(register, ["-f", fixture.fixture], { timeout: 10_000 });
    const ready = await runtime.start();
    async function check(phase: string, expectedPid?: number) {
      assert.deepEqual(
        await nativePids(),
        expectedPid === undefined ? [] : [expectedPid],
      );
      const matches = await until(phase, async () => {
        const result = await runtime.useClient((client, signal) =>
          client.callTool("list_apps", "{}", { signal }),
        );
        assert.equal(result.isError, false, result.text);
        const data = inventorySchema.parse(JSON.parse(result.structuredJson!));
        const matches = data.apps.filter(
          (entry) => entry.bundle_id === fixture.bundleId && entry.running,
        );
        if (expectedPid === undefined)
          return matches.length === 0 ? matches : undefined;
        return matches.length === 1 && matches[0]?.pid === expectedPid
          ? matches
          : undefined;
      });
      const current = await runtime.start();
      assert.equal(current.generation, ready.generation);
      const metadata = await runtime.useClient((client, signal) =>
        client.metadata({ signal }),
      );
      assert.equal(metadata.pid, ready.metadata.pid);
      observations.push({
        phase,
        generation: current.generation,
        daemonPid: metadata.pid,
        matches,
      });
      console.log(JSON.stringify(observations.at(-1)));
    }

    await check("initially stopped");
    await prepareLaunch();
    const launch = await runtime.useClient((client, signal) =>
      client.callTool(
        "launch_app",
        JSON.stringify({ bundle_id: fixture.bundleId }),
        { signal },
      ),
    );
    assert.equal(launch.isError, false, launch.text);
    const coldPid = await launched();
    const launchResult = z
      .object({
        pid: z.number().int().positive(),
        bundle_id: z.string(),
        launch_state: z.object({ process_running: z.literal(true) }),
      })
      .parse(JSON.parse(launch.structuredJson!));
    assert.equal(launchResult.pid, coldPid);
    assert.equal(launchResult.bundle_id, fixture.bundleId);
    await check("CUA cold launch", coldPid);
    await stopFixture();
    await check("CUA-launched process exited");

    await prepareLaunch();
    await execute("/usr/bin/open", ["-g", fixture.fixture], {
      timeout: 10_000,
    });
    const externalPid = await launched(coldPid);
    await check("external launch", externalPid);
    await stopFixture();
    await check("externally launched process exited");

    await prepareLaunch();
    await execute("/usr/bin/open", ["-g", fixture.fixture], {
      timeout: 10_000,
    });
    const reopenedPid = await launched(externalPid);
    await check("external reopen with new PID", reopenedPid);
    await stopFixture();
    await check("reopened process exited; old PIDs absent");
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await Promise.allSettled([
      stopFixture(),
      runtime.dispose(),
    ]);
    const unregister = await execute(register, ["-u", fixture.fixture], {
      timeout: 10_000,
    }).then(
      () => true,
      () => false,
    );
    const evidence = runtime.getCleanupEvidence();
    const success =
      failure === undefined &&
      cleanup.every((result) => result.status === "fulfilled") &&
      unregister &&
      evidence?.directoryRemoved &&
      evidence.process?.guardianExitObserved &&
      evidence.process.descendantsExited;
    await writeFile(
      path.join(output, "discovery.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          electron: process.versions.electron,
          fixtureBundleId: fixture.bundleId,
          boundary:
            "production runtime, helper, guardian and real pinned CUA SDK/daemon; no TCC or capture",
          observations,
          cleanup: evidence,
          fixtureStopped: fixturePid === undefined,
          fixtureUnregistered: unregister,
          success: Boolean(success),
          failure: failure instanceof Error ? failure.message : failure,
          cleanupFailures: cleanup
            .filter((result) => result.status === "rejected")
            .map((result) => String(result.reason)),
        },
        null,
        2,
      ) + "\n",
    );
    assert.ok(
      success,
      `Discovery proof failed; inspect ${path.join(output, "discovery.json")}`,
    );
  }
}

void app
  .whenReady()
  .then(prove)
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error);
      app.exit(1);
    },
  );
