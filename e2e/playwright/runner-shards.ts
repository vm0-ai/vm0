import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const DEFAULT_MAX_SHARDS = 12;

type CredentialLane = "limited-free" | "codex" | "claude";

const MAX_SHARDS_BY_LANE = {
  "limited-free": 4,
  codex: 2,
  claude: 1,
} satisfies Record<CredentialLane, number>;

interface WeightedTestFile {
  readonly credentialLane: CredentialLane;
  readonly path: string;
  readonly weight: number;
}

interface RunnerShard {
  readonly credentialLane: CredentialLane;
  readonly credentialIndex: number;
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
        credentialLane: source.includes(
          "e2e-api-credentials-runner-real-claude",
        )
          ? "claude"
          : source.includes("e2e-api-credentials-runner-real-codex")
            ? "codex"
            : "limited-free",
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
  const laneFiles = {
    "limited-free": files.filter((file) => {
      return file.credentialLane === "limited-free";
    }),
    codex: files.filter((file) => {
      return file.credentialLane === "codex";
    }),
    claude: files.filter((file) => {
      return file.credentialLane === "claude";
    }),
  } satisfies Record<CredentialLane, readonly WeightedTestFile[]>;
  const activeLanes = (["limited-free", "codex", "claude"] as const).filter(
    (lane) => {
      return laneFiles[lane].length > 0;
    },
  );
  const shardCapacity = activeLanes.reduce((total, lane) => {
    return total + Math.min(laneFiles[lane].length, MAX_SHARDS_BY_LANE[lane]);
  }, 0);
  const shardCount = Math.min(maxShards, files.length, shardCapacity);
  if (shardCount < activeLanes.length) {
    throw new Error(
      `Runner E2E requires at least ${activeLanes.length} shards to isolate credential lanes`,
    );
  }

  const laneShardCounts = new Map<CredentialLane, number>(
    activeLanes.map((lane) => [lane, 1]),
  );
  while (sumValues(laneShardCounts) < shardCount) {
    const lane = activeLanes.reduce<CredentialLane | undefined>(
      (selected, candidate) => {
        const candidateCount = laneShardCounts.get(candidate) ?? 0;
        if (
          candidateCount >=
          Math.min(laneFiles[candidate].length, MAX_SHARDS_BY_LANE[candidate])
        ) {
          return selected;
        }
        if (selected === undefined) {
          return candidate;
        }
        const selectedCount = laneShardCounts.get(selected) ?? 0;
        return laneFiles[candidate].length / candidateCount >
          laneFiles[selected].length / selectedCount
          ? candidate
          : selected;
      },
      undefined,
    );
    if (lane === undefined) {
      break;
    }
    laneShardCounts.set(lane, (laneShardCounts.get(lane) ?? 0) + 1);
  }

  const shards: RunnerShard[] = [];
  for (const lane of activeLanes) {
    const count = laneShardCounts.get(lane) ?? 0;
    const laneShards = Array.from({ length: count }, (_, index) => ({
      credentialLane: lane,
      credentialIndex: lane === "limited-free" ? index + 1 : 1,
      files: [],
      index: shards.length + index + 1,
      weight: 0,
    }));
    distributeFiles(laneFiles[lane], laneShards);
    shards.push(...laneShards);
  }

  return { include: shards };
}

function distributeFiles(
  files: readonly WeightedTestFile[],
  shards: RunnerShard[],
): void {
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
}

function sumValues(values: ReadonlyMap<CredentialLane, number>): number {
  let total = 0;
  for (const value of values.values()) {
    total += value;
  }
  return total;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
