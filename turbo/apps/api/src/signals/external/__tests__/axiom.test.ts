import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";

function sdkClientForDataset(
  mocks: ReturnType<typeof getApiTestMocks>,
  dataset: string,
) {
  const client = mocks.axiom.clients.find((candidate) => {
    return candidate.ingest.mock.calls.some(([actualDataset]) => {
      return actualDataset === dataset;
    });
  });
  if (!client) {
    throw new Error(`Expected Axiom SDK client for ${dataset}`);
  }
  return client;
}

describe("shared SDK ingestion", () => {
  it("attributes dataset failures and flushes every selected client", async () => {
    const { flushAxiom, ingestToAxiom } =
      await vi.importActual<typeof import("../axiom")>("../axiom");
    const mocks = getApiTestMocks();
    const restoreConsole = mocks.console.capture();
    onTestFinished(restoreConsole);

    const telemetryToken = "xaat-private-telemetry-token";
    const sessionsToken = "xaat-private-sessions-token";
    const requestDataset = "okou-request-log-shared-test";
    const contextDataset = "okou-run-context-shared-test";
    const sessionsDataset = "okou-agent-run-events-shared-test";
    const requestPayload = "private-request-payload";
    const secondRequestPayload = "private-second-request-payload";
    const contextPayload = "private-context-payload";
    const sessionsPayload = "private-sessions-payload";
    mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", telemetryToken);
    mockOptionalEnv("AXIOM_TOKEN_SESSIONS", sessionsToken);

    expect(
      ingestToAxiom(requestDataset, [{ value: requestPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(contextDataset, [{ value: contextPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(sessionsDataset, [{ value: sessionsPayload }]),
    ).toBeTruthy();
    expect(
      ingestToAxiom(requestDataset, [{ value: secondRequestPayload }]),
    ).toBeTruthy();

    const requestClient = sdkClientForDataset(mocks, requestDataset);
    const contextClient = sdkClientForDataset(mocks, contextDataset);
    const sessionsClient = sdkClientForDataset(mocks, sessionsDataset);
    expect(
      mocks.axiom.clients.filter((client) => {
        return client.ingest.mock.calls.length > 0;
      }),
    ).toHaveLength(3);
    expect(requestClient.options.token).toBe(telemetryToken);
    expect(contextClient.options.token).toBe(telemetryToken);
    expect(sessionsClient.options.token).toBe(sessionsToken);
    expect(requestClient.ingest.mock.calls).toStrictEqual([
      [requestDataset, [{ value: requestPayload }]],
      [requestDataset, [{ value: secondRequestPayload }]],
    ]);

    const requestError = new Error("The operation was aborted due to timeout");
    requestError.name = "TimeoutError";
    const contextError = new Error("connection refused");
    const requestOnError = requestClient.options.onError;
    const contextOnError = contextClient.options.onError;
    if (!requestOnError || !contextOnError) {
      throw new Error("Expected dataset-bound Axiom error callbacks");
    }
    requestOnError(requestError);
    contextOnError(contextError);

    const operationLogs = mocks.axiomLogging.error.mock.calls.filter(
      ([message]) => {
        return message === "Axiom client operation failed";
      },
    );
    expect(operationLogs).toStrictEqual([
      [
        "Axiom client operation failed",
        expect.objectContaining({
          client: "telemetry",
          dataset: requestDataset,
          failureKind: "timeout",
          error: requestError,
        }),
      ],
      [
        "Axiom client operation failed",
        expect.objectContaining({
          client: "telemetry",
          dataset: contextDataset,
          failureKind: "transport_error",
          error: contextError,
        }),
      ],
    ]);
    const serializedOperationLogs = JSON.stringify(operationLogs);
    for (const secret of [
      telemetryToken,
      sessionsToken,
      requestPayload,
      secondRequestPayload,
      contextPayload,
      sessionsPayload,
    ]) {
      expect(serializedOperationLogs).not.toContain(secret);
    }

    const flushController = new AbortController();
    onTestFinished(() => {
      flushController.abort();
    });
    const requestFlush = createDeferredPromise<void>(flushController.signal);
    const contextFlush = createDeferredPromise<void>(flushController.signal);
    requestClient.flush.mockReturnValueOnce(requestFlush.promise);
    contextClient.flush.mockReturnValueOnce(contextFlush.promise);
    sessionsClient.flush.mockResolvedValue(undefined);
    const telemetryFlush = flushAxiom({ client: "telemetry" });
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).not.toHaveBeenCalled();
    requestFlush.resolve();
    contextFlush.resolve();
    await expect(telemetryFlush).resolves.toBeUndefined();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    await expect(flushAxiom({ client: "sessions" })).resolves.toBeUndefined();
    expect(requestClient.flush).not.toHaveBeenCalled();
    expect(contextClient.flush).not.toHaveBeenCalled();
    expect(sessionsClient.flush).toHaveBeenCalledOnce();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    mocks.axiom.flush.mockResolvedValue(undefined);
    await expect(flushAxiom()).resolves.toBeUndefined();
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).toHaveBeenCalledOnce();

    requestClient.flush.mockClear();
    contextClient.flush.mockClear();
    sessionsClient.flush.mockClear();
    mocks.axiomLogging.error.mockClear();
    const flushError = new Error("flush rejected");
    requestClient.flush.mockRejectedValueOnce(flushError);
    contextClient.flush.mockResolvedValueOnce(undefined);
    await expect(flushAxiom({ client: "telemetry" })).resolves.toBeUndefined();
    expect(requestClient.flush).toHaveBeenCalledOnce();
    expect(contextClient.flush).toHaveBeenCalledOnce();
    expect(sessionsClient.flush).not.toHaveBeenCalled();
    expect(mocks.axiomLogging.error).toHaveBeenCalledWith(
      "Axiom client flush failed",
      expect.objectContaining({
        client: "telemetry",
        dataset: requestDataset,
        error: flushError,
      }),
    );
  });
});

describe("queryAxiom", () => {
  it("keeps the Axiom match timestamp when event data contains _time", async () => {
    const { queryAxiom } =
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

    const rows = await createStore().get(
      queryAxiom("['vm0-sandbox-telemetry-network-dev']"),
    );

    expect(rows).toStrictEqual([
      {
        _time: "2026-06-10T11:00:00Z",
        host: "api.example.com",
      },
    ]);
  });

  it("sends pagination cursor reads without using the Axiom cache", async () => {
    const { queryAxiom } =
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

    const rows = await createStore().get(
      queryAxiom(apl, {
        cursor: "cursor-next-page",
        noCache: true,
      }),
    );

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
