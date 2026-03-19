import { triggerSourceSchema, type TriggerSource } from "@vm0/core";

/**
 * Resolve the trigger source for an agent run.
 *
 * New rows have an explicit `triggerSource` column; for old rows that
 * predate the migration, we fall back to heuristic inference based on
 * `scheduleId` and `continuedFromSessionId`.
 */
export function inferTriggerSource(run: {
  triggerSource: string | null;
  scheduleId: string | null;
  continuedFromSessionId: string | null;
}): TriggerSource {
  if (run.triggerSource) {
    return triggerSourceSchema.parse(run.triggerSource);
  }
  // Fallback inference for old rows without trigger_source
  if (run.scheduleId) return "schedule";
  if (run.continuedFromSessionId) return "web";
  return "cli";
}
