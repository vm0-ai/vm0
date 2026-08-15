import { computed } from "ccstate";
import { zeroRunRunnerContract } from "@okouai/api-contracts/contracts/zero-runs";
import type {
  SandboxReuseResult,
  WorkspaceReuseResult,
} from "@okouai/api-contracts/contracts/webhooks";
import { zeroClient$ } from "../api-client.ts";
import { currentRunId$, zeroActivityDetail$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";
import type { LogStatus } from "../zero-page/log-types.ts";

interface ZeroActivityRunner {
  runId: string;
  status: LogStatus;
  runner: {
    sandboxReuseResult: SandboxReuseResult | null;
    workspaceReuseResult: WorkspaceReuseResult | null;
  };
}

export const zeroActivityRunner$ = computed(async (get) => {
  const runId = get(currentRunId$);
  const detail = await get(zeroActivityDetail$);
  if (!runId || !detail || detail.id !== runId) {
    return null;
  }

  const client = get(zeroClient$)(zeroRunRunnerContract);
  const result = await accept(
    client.getRunner({ params: { id: runId } }),
    [200],
  );
  return {
    runId,
    status: detail.status,
    runner: {
      sandboxReuseResult: result.body.sandboxReuseResult,
      workspaceReuseResult: result.body.workspaceReuseResult ?? null,
    },
  } satisfies ZeroActivityRunner;
});
