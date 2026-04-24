/* eslint-disable no-restricted-syntax -- This opt-in process harness reads raw env vars and controls child processes outside app env validation. */
/* eslint-disable turbo/no-undeclared-env-vars -- Repro-only env knobs should not affect normal Turbo task hashing. */
import { spawn, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

interface ProcessInfo {
  pid: number;
  ppid: number;
  args: string;
}

interface CpuReading {
  at: number;
  ticks: number;
}

interface CpuSample {
  at: string;
  cpuPercent: number;
  cpuSeconds: number;
  rssKb: number | null;
  threadCpu: ThreadCpuSample[];
}

interface PhaseMetrics {
  maxCpuPercent: number;
  cpuSeconds: number;
  samples: number;
}

interface ThreadReading {
  tid: number;
  name: string;
  ticks: number;
}

interface ThreadCpuSample {
  tid: number;
  name: string;
  cpuPercent: number;
  cpuSeconds: number;
}

interface ThreadCpuSummary {
  topThreads: ThreadCpuSummaryEntry[];
  topThreadNames: ThreadCpuSummaryEntry[];
}

interface ThreadCpuSummaryEntry {
  tid?: number;
  name: string;
  cpuSeconds: number;
  maxCpuPercent: number;
  samples: number;
}

interface CpuSampler {
  samples: CpuSample[];
  stop: () => void;
  done: Promise<void>;
}

const shouldRun = process.env.NEXT_DEV_CPU_REPRO === "1";
const describeRepro = shouldRun ? describe : describe.skip;

const webRoot = process.cwd();
const artifactsDir = resolve(webRoot, ".next/cpu-repro");
const cpuProfileDir = resolve(webRoot, ".next/cpu-profiles");

describeRepro("next dev CPU repro", () => {
  it("reproduces high CPU in the next-server process", async () => {
    const bundler = process.env.NEXT_DEV_CPU_BUNDLER ?? "turbo";
    if (bundler !== "turbo" && bundler !== "webpack") {
      throw new Error(
        `NEXT_DEV_CPU_BUNDLER must be "turbo" or "webpack", got "${bundler}"`,
      );
    }

    const port = Number(process.env.NEXT_DEV_CPU_PORT ?? 3173);
    const requestPath = normalizeRequestPath(
      process.env.NEXT_DEV_CPU_PATH ?? "/",
    );
    const minStartupCpu = Number(process.env.NEXT_DEV_CPU_MIN_STARTUP_CPU ?? 0);
    const minRequestCpu = Number(
      process.env.NEXT_DEV_CPU_MIN_REQUEST_CPU ?? 100,
    );
    const profileEnabled = process.env.NEXT_DEV_CPU_PROFILE !== "0";

    if (process.env.NEXT_DEV_CPU_COLD !== "0") {
      await rm(resolve(webRoot, ".next/dev"), {
        recursive: true,
        force: true,
      });
    }

    const profilesBefore = await listCpuProfiles();
    const childEnv = {
      ...process.env,
      ...parseDotEnvFile(resolve(webRoot, ".env.local")),
      NEXT_TELEMETRY_DISABLED: "1",
      VM0_API_URL: `http://localhost:${port}`,
    };

    const args = [
      "exec",
      "next",
      "dev",
      bundler === "webpack" ? "--webpack" : "--turbo",
      "--port",
      String(port),
    ];
    if (profileEnabled) {
      args.push("--experimental-cpu-prof");
    }

    const child = spawn("pnpm", args, {
      cwd: webRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 60_000) {
        output = output.slice(-60_000);
      }
    };
    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);

    let sampler: CpuSampler | undefined;
    let nextServerPid: number | undefined;

    try {
      if (!child.pid) {
        throw new Error("Failed to spawn pnpm next dev");
      }

      nextServerPid = await waitFor(
        () => {
          return findDescendantNextServerPid(child.pid!);
        },
        60_000,
        () => {
          return `next-server process. Recent output:\n${output}`;
        },
      );

      sampler = await startCpuSampler(nextServerPid);

      await waitFor(
        () => {
          if (output.includes("Another next dev server is already running")) {
            throw new Error(
              `A next dev server is already running for this app. Stop it before running this repro.\n${output}`,
            );
          }
          return output.includes("Ready in") ? true : undefined;
        },
        90_000,
        () => {
          return `next dev readiness. Recent output:\n${output}`;
        },
      );

      const startupSampleCount = sampler.samples.length;

      const curlOutput = await execFileText("curl", [
        "--max-time",
        "90",
        "-sS",
        "-o",
        "/tmp/next-dev-cpu-repro-root.html",
        "-w",
        "%{http_code} %{time_total}",
        `http://localhost:${port}${requestPath}`,
      ]);
      const [statusText, timeText] = curlOutput.trim().split(/\s+/);
      const responseStatus = Number(statusText);
      const requestMs = Math.round(Number(timeText) * 1000);

      const allSamples = sampler.samples;
      const startupSamples = allSamples.slice(0, startupSampleCount);
      const requestSamples = allSamples.slice(startupSampleCount);

      const metrics = {
        bundler,
        port,
        requestPath,
        nextServerPid,
        profileEnabled,
        responseStatus,
        requestMs,
        startup: summarizeSamples(startupSamples),
        rootRequest: summarizeSamples(requestSamples),
        total: summarizeSamples(allSamples),
        threadCpu: {
          startup: summarizeThreadCpu(startupSamples),
          rootRequest: summarizeThreadCpu(requestSamples),
          total: summarizeThreadCpu(allSamples),
        },
      };

      sampler.stop();
      await sampler.done;

      await stopProcessTree(child.pid);
      const profilesAfter = await listCpuProfiles();
      const newProfiles = [...profilesAfter].filter((profile) => {
        return !profilesBefore.has(profile);
      });

      const artifact = {
        ...metrics,
        cpuProfiles: newProfiles,
        logPath: "/tmp/next-dev-cpu-repro.log",
      };
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(
        join(
          artifactsDir,
          `next-dev-${bundler}-${artifactPathSegment(requestPath)}-cpu-repro.json`,
        ),
        JSON.stringify(artifact, null, 2),
      );
      await writeFile("/tmp/next-dev-cpu-repro.log", output);

      console.info(JSON.stringify(artifact, null, 2));

      expect(responseStatus).toBe(200);
      if (minStartupCpu > 0) {
        expect(metrics.startup.maxCpuPercent).toBeGreaterThan(minStartupCpu);
      }
      expect(metrics.rootRequest.maxCpuPercent).toBeGreaterThan(minRequestCpu);
    } finally {
      if (sampler) {
        sampler.stop();
        await sampler.done;
      }
      if (child.pid) {
        await stopProcessTree(child.pid);
      }
    }
  }, 180_000);
});

async function startCpuSampler(pid: number): Promise<CpuSampler> {
  const ticksPerSecond = Number(
    (await execFileText("getconf", ["CLK_TCK"])).trim(),
  );
  const samples: CpuSample[] = [];
  let stopped = false;

  async function loop(): Promise<void> {
    let previous = await readCpuReading(pid);
    let previousThreads = await readThreadReadings(pid);
    while (!stopped) {
      await delay(250);
      const current = await readCpuReading(pid);
      const currentThreads = await readThreadReadings(pid);
      if (!current) break;
      if (!previous) {
        previous = current;
        previousThreads = currentThreads;
        continue;
      }

      const wallSeconds = (current.at - previous.at) / 1000;
      const cpuSeconds = (current.ticks - previous.ticks) / ticksPerSecond;
      const cpuPercent =
        wallSeconds > 0 ? Math.max(0, (cpuSeconds / wallSeconds) * 100) : 0;

      samples.push({
        at: new Date(current.at).toISOString(),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        cpuSeconds: Math.round(cpuSeconds * 1000) / 1000,
        rssKb: await readRssKb(pid),
        threadCpu: summarizeThreadSample(
          previousThreads,
          currentThreads,
          ticksPerSecond,
          wallSeconds,
        ),
      });

      previous = current;
      previousThreads = currentThreads;
    }
  }

  const done = loop();
  return {
    samples,
    done,
    stop: () => {
      stopped = true;
    },
  };
}

async function readCpuReading(pid: number): Promise<CpuReading | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return {
      at: Date.now(),
      ticks: parseCpuTicksFromStat(stat),
    };
  } catch {
    return undefined;
  }
}

async function readThreadReadings(
  pid: number,
): Promise<ThreadReading[] | undefined> {
  try {
    const tids = await readdir(`/proc/${pid}/task`);
    const readings = await Promise.all(
      tids.map(async (tidText) => {
        const tid = Number(tidText);
        if (!Number.isInteger(tid)) return undefined;
        try {
          const [stat, comm] = await Promise.all([
            readFile(`/proc/${pid}/task/${tid}/stat`, "utf8"),
            readFile(`/proc/${pid}/task/${tid}/comm`, "utf8"),
          ]);
          return {
            tid,
            name: comm.trim(),
            ticks: parseCpuTicksFromStat(stat),
          };
        } catch {
          return undefined;
        }
      }),
    );
    return readings.filter((reading): reading is ThreadReading => {
      return reading !== undefined;
    });
  } catch {
    return undefined;
  }
}

function parseCpuTicksFromStat(stat: string): number {
  const endOfCommand = stat.lastIndexOf(")");
  const fields = stat
    .slice(endOfCommand + 2)
    .trim()
    .split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return utime + stime;
}

async function readRssKb(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function summarizeSamples(samples: CpuSample[]): PhaseMetrics {
  return {
    maxCpuPercent: Math.max(
      0,
      ...samples.map((sample) => {
        return sample.cpuPercent;
      }),
    ),
    cpuSeconds:
      Math.round(
        samples.reduce((sum, sample) => {
          return sum + sample.cpuSeconds;
        }, 0) * 1000,
      ) / 1000,
    samples: samples.length,
  };
}

function summarizeThreadSample(
  previousThreads: ThreadReading[] | undefined,
  currentThreads: ThreadReading[] | undefined,
  ticksPerSecond: number,
  wallSeconds: number,
): ThreadCpuSample[] {
  if (!previousThreads || !currentThreads || wallSeconds <= 0) return [];

  const previousByTid = new Map(
    previousThreads.map((thread) => {
      return [thread.tid, thread];
    }),
  );

  return currentThreads
    .map((thread) => {
      const previous = previousByTid.get(thread.tid);
      if (!previous) return undefined;

      const cpuSeconds = (thread.ticks - previous.ticks) / ticksPerSecond;
      if (cpuSeconds <= 0) return undefined;

      const cpuPercent = (cpuSeconds / wallSeconds) * 100;
      return {
        tid: thread.tid,
        name: thread.name,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        cpuSeconds: Math.round(cpuSeconds * 1000) / 1000,
      };
    })
    .filter((sample): sample is ThreadCpuSample => {
      return sample !== undefined;
    });
}

function summarizeThreadCpu(samples: CpuSample[]): ThreadCpuSummary {
  return {
    topThreads: summarizeThreadCpuGroups(samples, "thread"),
    topThreadNames: summarizeThreadCpuGroups(samples, "name"),
  };
}

function summarizeThreadCpuGroups(
  samples: CpuSample[],
  groupBy: "thread" | "name",
): ThreadCpuSummaryEntry[] {
  const groups = new Map<string, ThreadCpuSummaryEntry>();
  for (const sample of samples) {
    for (const threadSample of sample.threadCpu) {
      const key =
        groupBy === "thread"
          ? `${threadSample.tid}:${threadSample.name}`
          : threadSample.name;
      const existing = groups.get(key) ?? {
        ...(groupBy === "thread" ? { tid: threadSample.tid } : {}),
        name: threadSample.name,
        cpuSeconds: 0,
        maxCpuPercent: 0,
        samples: 0,
      };
      existing.cpuSeconds += threadSample.cpuSeconds;
      existing.maxCpuPercent = Math.max(
        existing.maxCpuPercent,
        threadSample.cpuPercent,
      );
      existing.samples += 1;
      groups.set(key, existing);
    }
  }

  return [...groups.values()]
    .map((group) => {
      return {
        ...group,
        cpuSeconds: Math.round(group.cpuSeconds * 1000) / 1000,
      };
    })
    .sort((a, b) => {
      return b.cpuSeconds - a.cpuSeconds;
    })
    .slice(0, 12);
}

async function findDescendantNextServerPid(
  rootPid: number,
): Promise<number | undefined> {
  const processes = await listProcesses();
  const byPid = new Map(
    processes.map((processInfo) => {
      return [processInfo.pid, processInfo];
    }),
  );

  const nextServer = processes.find((processInfo) => {
    return (
      processInfo.args.includes("next-server (v") &&
      isDescendant(processInfo.pid, rootPid, byPid)
    );
  });

  return nextServer?.pid;
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,args="]);
  return stdout
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) return undefined;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        args: match[3] ?? "",
      };
    })
    .filter((processInfo): processInfo is ProcessInfo => {
      return processInfo !== undefined;
    });
}

function isDescendant(
  pid: number,
  ancestorPid: number,
  byPid: Map<number, ProcessInfo>,
): boolean {
  let current = byPid.get(pid);
  while (current) {
    if (current.ppid === ancestorPid) return true;
    if (current.ppid === 0 || current.ppid === current.pid) return false;
    current = byPid.get(current.ppid);
  }
  return false;
}

async function stopProcessTree(rootPid: number): Promise<void> {
  const descendants = await listDescendantPids(rootPid);
  for (const pid of descendants.reverse()) {
    killIfRunning(pid, "SIGINT");
  }
  killIfRunning(rootPid, "SIGINT");

  await delay(3000);

  const remaining = await listDescendantPids(rootPid);
  for (const pid of remaining.reverse()) {
    killIfRunning(pid, "SIGKILL");
  }
  killIfRunning(rootPid, "SIGKILL");
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  const processes = await listProcesses();
  const byPid = new Map(
    processes.map((processInfo) => {
      return [processInfo.pid, processInfo];
    }),
  );
  return processes
    .filter((processInfo) => {
      return isDescendant(processInfo.pid, rootPid, byPid);
    })
    .map((processInfo) => {
      return processInfo.pid;
    });
}

function killIfRunning(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function normalizeRequestPath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path;
}

function artifactPathSegment(path: string): string {
  if (path === "/") return "root";
  return path
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function waitFor<T>(
  getValue: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  label: () => string,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await getValue();
    if (value !== undefined) {
      return value;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label()}`);
}

async function execFileText(file: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              `${file} ${args.join(" ")} failed: ${stderr || error.message}`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function listCpuProfiles(): Promise<Set<string>> {
  try {
    const entries = await readdir(cpuProfileDir);
    return new Set(
      entries
        .filter((entry) => {
          return entry.endsWith(".cpuprofile");
        })
        .map((entry) => {
          return join(cpuProfileDir, entry);
        }),
    );
  } catch {
    return new Set();
  }
}

function parseDotEnvFile(path: string): Record<string, string> {
  try {
    const contents = readFileSync(path, "utf8");
    const env: Record<string, string> = {};
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}
