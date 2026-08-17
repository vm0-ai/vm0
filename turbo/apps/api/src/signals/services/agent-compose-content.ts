import { createHash } from "node:crypto";
import { getInstructionsFilename } from "@okouai/core/frameworks";
import { APPLICATION_OWNED_AGENT_EXECUTION_PLAN } from "./agent-execution-plan";

/**
 * Canonical application-owned content for a Zero Agent compose.
 *
 * This shape is content-addressed in production. Keep the builder and its
 * canonical hash together so transition validators cannot drift from the
 * runtime writer.
 */
export function buildZeroAgentComposeContent(
  agentName: string,
): Record<string, unknown> {
  const plan = APPLICATION_OWNED_AGENT_EXECUTION_PLAN;
  const environment: Record<string, string> = {
    [plan.environment.legacySerializedBindings.agentId]:
      `\${{ vars.OKOU_AGENT_ID }}`,
    [plan.environment.legacySerializedBindings.token]:
      `\${{ secrets.OKOU_TOKEN }}`,
  };

  const agentDef: Record<string, unknown> = {
    framework: plan.framework.fallback,
    instructions: getInstructionsFilename(plan.framework.fallback),
    environment,
  };

  return {
    version: "1",
    agents: { [agentName]: agentDef },
  };
}

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** SHA-256 of the runtime canonical-JSON representation of compose content. */
export function computeComposeVersionId(
  content: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(sortObjectKeys(content));
  return createHash("sha256").update(canonical).digest("hex");
}
