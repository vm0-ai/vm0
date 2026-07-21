import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-context";

const context = testContext();
const { flushAxiom, ingestRequiredToAxiom, ingestToAxiom } =
  await vi.importActual<typeof import("../axiom")>("../axiom");

interface CapturedAxiomRequest {
  readonly authorization: string | null;
  readonly body: string;
  readonly contentType: string | null;
  readonly dataset: string;
}

function successfulIngestStatus(ingested: number): Record<string, unknown> {
  return {
    ingested,
    failed: 0,
    failures: [],
    processedBytes: 1,
    blocksCreated: 0,
    walLength: ingested,
  };
}

beforeEach(() => {
  context.mocks.axiom.useRealSdk.mockReturnValue(true);
});

describe("required Axiom delivery", () => {
  it("awaits the real SDK request with the selected token and NDJSON body", async () => {
    const requests: CapturedAxiomRequest[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/:dataset/ingest",
        async ({ params, request }) => {
          requests.push({
            authorization: request.headers.get("authorization"),
            body: await request.text(),
            contentType: request.headers.get("content-type"),
            dataset: String(params.dataset),
          });
          return HttpResponse.json(successfulIngestStatus(2));
        },
      ),
    );

    await expect(
      ingestRequiredToAxiom("vm0-agent-run-events-dev", [
        { sequenceNumber: 1 },
        { sequenceNumber: 2 },
      ]),
    ).resolves.toBeTruthy();

    expect(requests).toStrictEqual([
      {
        authorization: "Bearer xaat-test-sessions",
        body: '{"sequenceNumber":1}\n{"sequenceNumber":2}',
        contentType: "application/x-ndjson",
        dataset: "vm0-agent-run-events-dev",
      },
    ]);
  });

  it("rejects a real SDK 5xx callback with request-local context", async () => {
    let attempts = 0;
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        attempts += 1;
        return HttpResponse.json(
          { message: "forced Axiom failure" },
          { status: 500 },
        );
      }),
    );

    await expect(
      ingestRequiredToAxiom("vm0-agent-run-events-dev", [{ id: "event" }]),
    ).rejects.toMatchObject({
      message:
        'Required Axiom ingest failed for sessions dataset "vm0-agent-run-events-dev"',
      cause: expect.objectContaining({ message: "forced Axiom failure" }),
    });
    expect(attempts).toBe(2);
  });

  it("rejects a response that reports failed events", async () => {
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        return HttpResponse.json({
          ingested: 1,
          failed: 1,
          failures: [{ error: "invalid event", index: 1 }],
          processedBytes: 1,
          blocksCreated: 0,
          walLength: 1,
        });
      }),
    );

    await expect(
      ingestRequiredToAxiom("vm0-sandbox-telemetry-system-dev", [
        { id: "accepted" },
        { id: "rejected" },
      ]),
    ).rejects.toMatchObject({
      message:
        'Required Axiom ingest failed for telemetry dataset "vm0-sandbox-telemetry-system-dev"',
      cause: expect.objectContaining({
        message: "Axiom reported 1 failed event(s)",
      }),
    });
  });

  it("keeps overlapping delivery outcomes isolated", async () => {
    let started = 0;
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/:dataset/ingest",
        ({ params }) => {
          started += 1;
          if (String(params.dataset).includes("agent-run-events")) {
            return HttpResponse.json(
              { message: "sessions delivery failed" },
              { status: 400 },
            );
          }
          return HttpResponse.json(successfulIngestStatus(1));
        },
      ),
    );

    const results = await Promise.allSettled([
      ingestRequiredToAxiom("vm0-agent-run-events-dev", [{ id: "sessions" }]),
      ingestRequiredToAxiom("vm0-sandbox-telemetry-system-dev", [
        { id: "telemetry" },
      ]),
    ]);

    expect(results).toStrictEqual([
      {
        status: "rejected",
        reason: expect.objectContaining({
          message:
            'Required Axiom ingest failed for sessions dataset "vm0-agent-run-events-dev"',
          cause: expect.objectContaining({
            message: "sessions delivery failed",
          }),
        }),
      },
      { status: "fulfilled", value: true },
    ]);
    expect(started).toBe(2);
  });

  it("returns false without making a request when the token is absent", async () => {
    let requests = 0;
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", undefined);
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        requests += 1;
        return HttpResponse.json(successfulIngestStatus(1));
      }),
    );

    await expect(
      ingestRequiredToAxiom("vm0-agent-run-events-dev", [{ id: "event" }]),
    ).resolves.toBeFalsy();
    expect(requests).toBe(0);
  });
});

describe("best-effort Axiom delivery", () => {
  it("logs SDK delivery errors without rejecting the drain", async () => {
    server.use(
      http.post("https://api.axiom.co/v1/datasets/:dataset/ingest", () => {
        return HttpResponse.json(
          { message: "best-effort delivery failed" },
          { status: 400 },
        );
      }),
    );

    expect(
      ingestToAxiom("vm0-api-request-log-dev", [{ path: "/health" }]),
    ).toBeTruthy();
    await expect(flushAxiom({ client: "telemetry" })).resolves.toBeUndefined();

    expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
      "Best-effort Axiom delivery failed",
      expect.objectContaining({
        client: "telemetry",
        context: "axiom",
        error: expect.objectContaining({
          message: "best-effort delivery failed",
        }),
      }),
    );
  });
});
