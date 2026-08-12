import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const DEFAULT_MAX_SHARDS = 12;

interface WeightedTestFile {
  readonly path: string;
  readonly weight: number;
}

interface RunnerShard {
  readonly files: string[];
  readonly index: number;
  weight: number;
}

async function main(): Promise<void> {
  const testDirectory = resolve(process.argv[2] ?? "tests/03-runner");
  const maxShards = parseMaxShards(process.argv[3]);
  const files = await discoverTestFiles(testDirectory);
  const matrix = buildMatrix(files, maxShards);
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
}

function parseMaxShards(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_SHARDS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Runner E2E max shards must be a positive integer: ${value}`,
    );
  }
  return parsed;
}

async function discoverTestFiles(
  testDirectory: string,
): Promise<readonly WeightedTestFile[]> {
  const entries = await readdir(testDirectory, { withFileTypes: true });
  const batsFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".bats"))
    .map((entry) => resolve(testDirectory, entry.name))
    .sort();

  if (batsFiles.length === 0) {
    throw new Error(`No runner E2E test files found in ${testDirectory}`);
  }

  return await Promise.all(
    batsFiles.map(async (filePath) => {
      const source = await readFile(filePath, "utf8");
      const weight = source.match(/^\s*@test\b/gmu)?.length ?? 0;
      if (weight === 0) {
        throw new Error(`Runner E2E test file has no tests: ${filePath}`);
      }
      return {
        path: relative(process.cwd(), filePath).split(sep).join("/"),
        weight,
      };
    }),
  );
}

function buildMatrix(
  files: readonly WeightedTestFile[],
  maxShards: number,
): {
  readonly include: readonly RunnerShard[];
} {
  const shardCount = Math.min(maxShards, files.length);
  const shards: RunnerShard[] = Array.from(
    { length: shardCount },
    (_, index) => ({ files: [], index: index + 1, weight: 0 }),
  );
  const orderedFiles = [...files].sort((left, right) => {
    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

  for (const file of orderedFiles) {
    const shard = shards.reduce((lightest, candidate) => {
      if (candidate.weight !== lightest.weight) {
        return candidate.weight < lightest.weight ? candidate : lightest;
      }
      return candidate.index < lightest.index ? candidate : lightest;
    });
    shard.files.push(file.path);
    shard.weight += file.weight;
  }

  for (const shard of shards) {
    shard.files.sort();
  }

  return { include: shards };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
