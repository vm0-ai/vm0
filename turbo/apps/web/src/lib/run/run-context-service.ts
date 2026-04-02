import { queryAxiom, type RunContextSnapshot } from "../shared/axiom/client";
import { getDatasetName, DATASETS } from "../shared/axiom/datasets";

/**
 * Query a run's execution context snapshot from Axiom.
 * Returns null if the snapshot is not available (old runs or ingestion delay).
 */
export async function queryRunContext(
  runId: string,
): Promise<RunContextSnapshot | null> {
  // Sanitize runId to prevent APL injection — only allow alphanumeric, hyphens, and underscores
  const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitizedRunId !== runId) {
    return null;
  }

  const dataset = getDatasetName(DATASETS.RUN_CONTEXT);
  const apl = `['${dataset}']
| where runId == "${sanitizedRunId}"
| limit 1`;

  const results = await queryAxiom<RunContextSnapshot>(apl);
  return results[0] ?? null;
}
