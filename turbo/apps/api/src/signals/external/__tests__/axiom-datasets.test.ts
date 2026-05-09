import { describe, expect, it } from "vitest";

import { getAxiomTokenEnvNameForApl } from "../axiom-datasets";

describe("getAxiomTokenEnvNameForApl", () => {
  it("uses the sessions token for agent run events", () => {
    expect(
      getAxiomTokenEnvNameForApl(
        "['vm0-agent-run-events-dev'] | where runId == \"run_123\"",
      ),
    ).toBe("AXIOM_TOKEN_SESSIONS");
  });

  it("uses the telemetry token for telemetry datasets", () => {
    expect(
      getAxiomTokenEnvNameForApl(
        "['vm0-sandbox-telemetry-network-dev'] | limit 1",
      ),
    ).toBe("AXIOM_TOKEN_TELEMETRY");
  });

  it("defaults unknown APL to the telemetry token", () => {
    expect(getAxiomTokenEnvNameForApl("limit 1")).toBe("AXIOM_TOKEN_TELEMETRY");
  });
});
