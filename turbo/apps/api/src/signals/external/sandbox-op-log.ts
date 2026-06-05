import { Axiom } from "@axiomhq/js";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { tapError } from "../utils";

interface AxiomIngestClient {
  readonly ingest: (
    dataset: string,
    events: readonly Record<string, unknown>[],
  ) => Promise<unknown> | unknown;
}

interface SandboxOperationAttrs {
  readonly sandboxType: "runner" | "docker" | "chat";
  readonly actionType: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly runId: string;
  readonly timestamp?: string;
  readonly dimensions?: Record<string, unknown>;
}

const telemetryAxiomClient = singleton((): Axiom => {
  return new Axiom({ token: env("AXIOM_TOKEN_TELEMETRY") });
});
const L = logger("SandboxOpLog");

function hasIngest(client: Axiom): client is Axiom & AxiomIngestClient {
  return (
    "ingest" in client &&
    typeof (client as { readonly ingest: unknown }).ingest === "function"
  );
}

export function recordSandboxOperation(attrs: SandboxOperationAttrs): void {
  const client = telemetryAxiomClient();
  if (!hasIngest(client)) {
    return;
  }

  const dataset = `vm0-sandbox-op-log-${env("AXIOM_DATASET_SUFFIX")}`;
  waitUntil(
    tapError(
      Promise.resolve(
        client.ingest(dataset, [
          {
            _time: attrs.timestamp ?? nowDate().toISOString(),
            source: "api",
            op_type: attrs.actionType,
            sandbox_type: attrs.sandboxType,
            duration_ms: attrs.durationMs,
            success: attrs.success,
            run_id: attrs.runId,
            ...attrs.dimensions,
          },
        ]),
      ),
      (error) => {
        L.warn("Failed to ingest sandbox operation log", { error });
      },
    ),
  );
}
