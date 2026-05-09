import { queryAxiom, type RunContextSnapshot } from "../../shared/axiom/client";
import { getDatasetName, DATASETS } from "../../shared/axiom/datasets";
import { escapeAplString } from "../../shared/axiom/apl";

/**
 * Query a run's execution context snapshot from Axiom.
 * Returns null if the snapshot is not available (old runs or ingestion delay).
 */
export async function queryRunContext(
  runId: string,
): Promise<RunContextSnapshot | null> {
  const dataset = getDatasetName(DATASETS.RUN_CONTEXT);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| limit 1`;

  const results = await queryAxiom<RunContextSnapshot>(apl);
  return results[0] ?? null;
}
