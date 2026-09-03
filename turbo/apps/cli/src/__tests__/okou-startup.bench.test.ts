import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHOULD_RUN = process.env.OKOU_STARTUP_BENCH === "1";
const RUNS = Number(process.env.OKOU_STARTUP_BENCH_RUNS ?? "15");
const MAX_MEDIAN_MS = Number(process.env.OKOU_STARTUP_BENCH_MAX_MS ?? "550");
const OKOU_DIST_PATH = fileURLToPath(
  new URL("../../dist/okou.js", import.meta.url),
);

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]!;
}

function benchmarkEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    SENTRY_DSN: "",
    OKOU_TOKEN: "",
  };

  for (const key of [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
  ]) {
    delete env[key];
  }

  return env;
}

function measureStartupMs(env: NodeJS.ProcessEnv): number {
  const start = performance.now();
  const result = spawnSync(process.execPath, [OKOU_DIST_PATH, "--help"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const duration = performance.now() - start;

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Usage: okou");
  return duration;
}

describe.skipIf(!SHOULD_RUN)("Okou startup benchmark", () => {
  it("keeps the built Okou help path fast", () => {
    expect(
      existsSync(OKOU_DIST_PATH),
      "Run `pnpm -F @okouai/cli build` before the startup benchmark.",
    ).toBe(true);

    const env = benchmarkEnv();
    measureStartupMs(env);

    const timings = Array.from({ length: RUNS }, () => {
      return measureStartupMs(env);
    }).sort((a, b) => {
      return a - b;
    });

    const median = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    console.info(
      `okou startup: runs=${RUNS} median=${median.toFixed(
        1,
      )}ms p95=${p95.toFixed(1)}ms maxMedian=${MAX_MEDIAN_MS}ms`,
    );

    expect(median).toBeLessThanOrEqual(MAX_MEDIAN_MS);
  }, 120_000);
});
