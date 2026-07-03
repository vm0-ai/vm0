import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { server } from "../../../mocks/server";

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

  it("sends the pagination cursor in the documented Axiom request body", async () => {
    const { queryAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    const apl = "['vm0-agent-run-events-dev'] | limit 1";
    const requests: {
      readonly authorization: string | null;
      readonly body: unknown;
      readonly url: string;
    }[] = [];

    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/_apl",
        async ({ request }) => {
          requests.push({
            authorization: request.headers.get("authorization"),
            body: await request.json(),
            url: request.url,
          });

          return HttpResponse.json({
            matches: [
              {
                _time: "2026-06-10T12:00:00Z",
                data: {
                  _time: "not-a-timestamp",
                  log: "next page",
                },
              },
            ],
          });
        },
      ),
    );

    const rows = await queryAxiomDirect(apl, {
      cursor: "cursor-next-page",
      noCache: true,
    });

    expect(mocks.axiom.query).not.toHaveBeenCalled();
    expect(requests).toStrictEqual([
      {
        authorization: "Bearer xaat-test-sessions",
        body: {
          apl,
          cursor: "cursor-next-page",
        },
        url: "https://api.axiom.co/v1/datasets/_apl?format=legacy&nocache=true",
      },
    ]);
    expect(rows).toStrictEqual([
      {
        _time: "2026-06-10T12:00:00Z",
        log: "next page",
      },
    ]);
  });
});
