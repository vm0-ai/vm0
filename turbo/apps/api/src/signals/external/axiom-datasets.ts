type AxiomTokenEnvName = "AXIOM_TOKEN_SESSIONS" | "AXIOM_TOKEN_TELEMETRY";

function extractDatasetFromApl(apl: string): string | null {
  const match = apl.match(/\['([^']+)'\]/);
  return match?.[1] ?? null;
}

function isSessionsDataset(datasetName: string | null): boolean {
  return datasetName?.includes("agent-run-events") ?? false;
}

export function getAxiomTokenEnvNameForApl(apl: string): AxiomTokenEnvName {
  return isSessionsDataset(extractDatasetFromApl(apl))
    ? "AXIOM_TOKEN_SESSIONS"
    : "AXIOM_TOKEN_TELEMETRY";
}
