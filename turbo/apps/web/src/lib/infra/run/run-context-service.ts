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
  const snapshot = results[0];
  if (!snapshot) {
    return null;
  }
  // Axiom can return entries whose values lost their string type during
  // serialize/round-trip (e.g. ingested as empty strings, returned as null).
  // The ts-rest response schema requires Record<string, string>, so drop any
  // non-string values to keep the contract intact.
  return { ...snapshot, environment: filterStringValues(snapshot.environment) };
}

function filterStringValues(
  value: Record<string, unknown> | null | undefined,
): Record<string, string> {
  if (!value) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  return Object.fromEntries(entries);
}
