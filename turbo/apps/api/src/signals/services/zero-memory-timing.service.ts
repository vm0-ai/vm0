export type ZeroMemoryTimingStage =
  | "runtime_injection"
  | "document_search"
  | "document_search_lexical"
  | "document_search_semantic_embedding"
  | "document_search_semantic_query"
  | "document_search_hydrate"
  | "profile_static"
  | "profile_dynamic"
  | "profile_search"
  | "profile_search_exact_identity"
  | "profile_search_semantic_embedding"
  | "profile_search_semantic_query"
  | "profile_search_graph_expansion"
  | "profile_search_seed_rank"
  | "profile_search_final_rank"
  | "profile_hydrate"
  | "profile_load_sources";

export type ZeroMemoryTimingDimensions = Readonly<Record<string, string>>;
export type ZeroMemoryTimingDimensionsInput =
  | ZeroMemoryTimingDimensions
  | (() => ZeroMemoryTimingDimensions | undefined);

export interface ZeroMemoryTimingObserver {
  measure<T>(
    stage: ZeroMemoryTimingStage,
    operation: () => T | Promise<T>,
    dimensions?: ZeroMemoryTimingDimensionsInput,
  ): Promise<T>;
}

const COUNT_BUCKETS = ["0", "1", "2_4", "5_8", "9_16", "17_plus"] as const;

export function zeroMemoryCountBucket(
  count: number,
): (typeof COUNT_BUCKETS)[number] {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

export function zeroMemoryPromptLengthBucket(prompt: string): string {
  const length = prompt.length;
  if (length <= 0) {
    return "0";
  }
  if (length <= 256) {
    return "1_256";
  }
  if (length <= 1024) {
    return "257_1024";
  }
  if (length <= 4096) {
    return "1025_4096";
  }
  if (length <= 16_384) {
    return "4097_16384";
  }
  return "16385_plus";
}

export async function measureZeroMemoryTiming<T>(
  observer: ZeroMemoryTimingObserver | undefined,
  stage: ZeroMemoryTimingStage,
  operation: () => T | Promise<T>,
  dimensions?: ZeroMemoryTimingDimensionsInput,
): Promise<T> {
  if (!observer) {
    return await operation();
  }
  return await observer.measure(stage, operation, dimensions);
}
