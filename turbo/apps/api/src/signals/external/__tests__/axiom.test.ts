import { describe, expect, it, vi } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";

describe("queryAxiomDirect", () => {
  it("keeps the Axiom match timestamp when event data contains _time", async () => {
    const { queryAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    mocks.axiom.query.mockResolvedValue({
      matches: [
        {
          _time: "2026-06-10T11:00:00Z",
          data: {
            _time: "not-a-timestamp",
            host: "api.example.com",
          },
        },
      ],
    });

    const rows = await queryAxiomDirect(
      "['vm0-sandbox-telemetry-network-dev']",
    );

    expect(rows).toStrictEqual([
      {
        _time: "2026-06-10T11:00:00Z",
        host: "api.example.com",
      },
    ]);
  });
});
