import { normalizeRunModelId } from "@okouai/api-contracts/contracts/model-providers";

export interface SessionExecutionIdentity {
  readonly selectedModel: string | null;
  readonly cliAgentType: string | null;
}

function modelFamily(model: string): string {
  const normalized = normalizeRunModelId(model.trim()).toLowerCase();
  const modelName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return modelName.replace(/[-_.].*$/, "");
}

/** Native session history is reusable within one runtime and model family. */
export function canReuseSession(
  previous: SessionExecutionIdentity,
  next: SessionExecutionIdentity,
): boolean {
  return (
    previous.cliAgentType !== null &&
    previous.cliAgentType === next.cliAgentType &&
    previous.selectedModel !== null &&
    next.selectedModel !== null &&
    modelFamily(previous.selectedModel) === modelFamily(next.selectedModel)
  );
}
