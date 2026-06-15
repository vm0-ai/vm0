import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { TestModule } from "vitest/node";
import type { Reporter, TestRunEndReason } from "vitest/reporters";

interface BenchmarkJson {
  files: {
    filepath: string;
    groups: {
      fullName: string;
      benchmarks: Record<string, unknown>[];
    }[];
  }[];
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  if (sortedSamples.length === 0) {
    return Number.NaN;
  }
  const index = Math.ceil(percentileValue * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, Math.min(sortedSamples.length - 1, index))]!;
}

function fullName(task: { name?: string; suite?: unknown }): string {
  const names: string[] = [];
  let current: unknown = task;

  while (current && typeof current === "object") {
    const candidate = current as { name?: string; suite?: unknown };
    if (candidate.name) {
      names.push(candidate.name);
    }
    current = candidate.suite;
  }

  return names.reverse().join(" > ");
}

// Vitest custom reporters are loaded from the default export.
// oxlint-disable-next-line eslint-plugin-import(no-default-export)
export default class BenchP90Reporter implements Reporter {
  onTestRunEnd(
    testModules: readonly TestModule[],
    _errors: readonly unknown[],
    _reason: TestRunEndReason,
  ): void {
    const report: BenchmarkJson = { files: [] };

    for (const mod of testModules) {
      const groupsByName = new Map<string, Record<string, unknown>[]>();

      for (const test of mod.children.allTests()) {
        const task = test.task as {
          id?: string;
          name?: string;
          suite?: { name?: string };
          meta?: { benchmark?: boolean };
          result?: { benchmark?: Record<string, unknown> };
        };
        const result = task.result?.benchmark;
        if (!task.meta?.benchmark || !result) {
          continue;
        }

        const samples = Array.isArray(result.samples)
          ? result.samples.filter((sample): sample is number => {
              return typeof sample === "number" && Number.isFinite(sample);
            })
          : [];
        const sortedSamples = [...samples].sort((a, b) => {
          return a - b;
        });
        const groupName = task.suite
          ? fullName(task.suite)
          : mod.relativeModuleId;
        const benchmarks = groupsByName.get(groupName) ?? [];

        benchmarks.push({
          id: task.id,
          name: task.name,
          ...result,
          p90: percentile(sortedSamples, 0.9),
          sampleCount: samples.length,
        });
        groupsByName.set(groupName, benchmarks);
      }

      if (groupsByName.size > 0) {
        report.files.push({
          filepath: mod.relativeModuleId,
          groups: [...groupsByName.entries()].map(([groupName, benchmarks]) => {
            return {
              fullName: groupName,
              benchmarks,
            };
          }),
        });
      }
    }

    const outputPath = resolve(
      process.cwd(),
      process.env.VITEST_BENCH_P90_JSON ?? "bench-results-p90.json",
    );
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}
