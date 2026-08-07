const WORKER_ENV_SHARD_PREFIX = "VM0_WORKER_ENV_";
const WORKER_ENV_SHARD_COUNT = 32;

function shardName(index: number): string {
  return `${WORKER_ENV_SHARD_PREFIX}${String(index).padStart(2, "0")}`;
}

function parsedShard(value: string, name: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") {
      throw new Error(`${name}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

export function resolveRuntimeEnv(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = { ...source };
  const shardValues = Array.from(
    { length: WORKER_ENV_SHARD_COUNT },
    (_, index) => {
      return source[shardName(index + 1)];
    },
  );
  const hasShards = shardValues.some((value) => {
    return value !== undefined;
  });
  if (!hasShards) {
    return result;
  }

  const seen = new Set<string>();
  for (const [index, value] of shardValues.entries()) {
    const name = shardName(index + 1);
    if (value === undefined) {
      throw new Error(`${name} is missing from the Worker environment`);
    }
    for (const [key, entry] of Object.entries(parsedShard(value, name))) {
      if (seen.has(key)) {
        throw new Error(
          `${key} is duplicated across Worker environment shards`,
        );
      }
      seen.add(key);
      result[key] = entry;
    }
    delete result[name];
  }
  return result;
}
