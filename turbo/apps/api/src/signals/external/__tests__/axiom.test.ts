import { delay, HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";

const DATASET = "vm0-agent-run-events-dev";
const INGEST_URL = `https://api.axiom.co/v1/datasets/${DATASET}/ingest`;

function successfulIngestStatus(ingested: number) {
  return {
    ingested,
    failed: 0,
    processedBytes: 123,
    blocksCreated: 1,
    walLength: 456,
  };
}

describe("ingestAxiomDirect", () => {
  it("sends one authenticated request and validates complete acceptance", async () => {
    const { ingestAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const requests: {
      readonly authorization: string | null;
      readonly body: unknown;
      readonly contentType: string | null;
    }[] = [];
    const events = [
      { runId: "run-1", sequenceNumber: 1 },
      { runId: "run-1", sequenceNumber: 2 },
    ];
    server.use(
      http.post(INGEST_URL, async ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          body: await request.json(),
          contentType: request.headers.get("content-type"),
        });
        return HttpResponse.json(successfulIngestStatus(events.length));
      }),
    );

    const result = await ingestAxiomDirect(
      DATASET,
      events,
      AbortSignal.any([]),
    );

    expect(result).toStrictEqual({
      configured: true,
      status: successfulIngestStatus(events.length),
    });
    expect(requests).toStrictEqual([
      {
        authorization: "Bearer xaat-test-sessions",
        body: events,
        contentType: "application/json",
      },
    ]);
  });

  it("reports an unconfigured dataset without issuing a request", async () => {
    const { ingestAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", undefined);
    let requestCount = 0;
    server.use(
      http.post(INGEST_URL, () => {
        requestCount += 1;
        return HttpResponse.json(successfulIngestStatus(1));
      }),
    );

    await expect(
      ingestAxiomDirect(DATASET, [{ runId: "run-1" }], AbortSignal.any([])),
    ).resolves.toStrictEqual({ configured: false });
    expect(requestCount).toBe(0);
  });

  it("does not retry an Axiom 503", async () => {
    const { ingestAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    let requestCount = 0;
    server.use(
      http.post(INGEST_URL, () => {
        requestCount += 1;
        return HttpResponse.text("unavailable", { status: 503 });
      }),
    );

    await expect(
      ingestAxiomDirect(DATASET, [{ runId: "run-1" }], AbortSignal.any([])),
    ).rejects.toMatchObject({
      name: "DirectAxiomIngestError",
      reason: "http_status",
      status: 503,
    });
    expect(requestCount).toBe(1);
  });

  it.each([
    {
      name: "missing numeric status fields",
      status: { ingested: 1, failed: 0 },
    },
    {
      name: "a failed event",
      status: {
        ...successfulIngestStatus(0),
        failed: 1,
        failures: [{ timestamp: "2026-07-30T00:00:00Z", error: "bad row" }],
      },
    },
    {
      name: "failure details with a zero failed count",
      status: {
        ...successfulIngestStatus(1),
        failures: [
          {
            timestamp: "2026-07-30T00:00:00Z",
            error: "inconsistent failed row",
          },
        ],
      },
    },
    {
      name: "an ingested count mismatch",
      status: successfulIngestStatus(0),
    },
  ])("rejects $name", async ({ status }) => {
    const { ingestAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    server.use(
      http.post(INGEST_URL, () => {
        return HttpResponse.json(status);
      }),
    );

    await expect(
      ingestAxiomDirect(DATASET, [{ runId: "run-1" }], AbortSignal.any([])),
    ).rejects.toMatchObject({
      name: "DirectAxiomIngestError",
    });
  });

  it("observes the caller deadline", async () => {
    const { ingestAxiomDirect } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    server.use(
      http.post(INGEST_URL, async () => {
        await delay(100);
        return HttpResponse.json(successfulIngestStatus(1));
      }),
    );

    await expect(
      ingestAxiomDirect(DATASET, [{ runId: "run-1" }], AbortSignal.timeout(5)),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

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
