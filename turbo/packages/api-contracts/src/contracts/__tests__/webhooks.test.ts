import { describe, expect, it } from "vitest";

import { SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT } from "../runners";
import { webhookTelemetryContract } from "../webhooks";

describe("webhook telemetry contract", () => {
  it("accepts known session history download sources", () => {
    const result = webhookTelemetryContract.send.body.safeParse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_download",
          duration_ms: 10,
          success: true,
          session_history_download_source:
            SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown session history download sources", () => {
    const result = webhookTelemetryContract.send.body.safeParse({
      runId: "00000000-0000-4000-8000-000000000000",
      sandboxOperations: [
        {
          ts: "2026-01-15T10:00:00.000Z",
          action_type: "session_history_download",
          duration_ms: 10,
          success: true,
          session_history_download_source: "regional_edge_cache",
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
