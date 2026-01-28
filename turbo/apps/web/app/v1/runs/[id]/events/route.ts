/**
 * Public API v1 - Run Events Stream Endpoint
 *
 * GET /v1/runs/:id/events - Stream real-time events using SSE
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";
import { NextRequest } from "next/server";

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

interface RunResult {
  output?: string;
  checkpointId?: string;
  agentSessionId?: string;
  artifact?: Record<string, string>;
  volumes?: Record<string, string>;
}

const TERMINAL_STATUSES = ["completed", "failed", "timeout", "cancelled"];
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Format SSE message
 */
function formatSSE(event: string, data: unknown, id?: string): string {
  let message = "";
  if (id) {
    message += `id: ${id}\n`;
  }
  message += `event: ${event}\n`;
  message += `data: ${JSON.stringify(data)}\n\n`;
  return message;
}

/**
 * Create error response in JSON format
 */
function createErrorResponse(
  status: number,
  type: string,
  code: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: { type, code, message },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  initServices();

  const auth = await authenticatePublicApi(
    request.headers.get("Authorization") ?? undefined,
  );
  if (!isAuthSuccess(auth)) {
    return createErrorResponse(
      401,
      "authentication_error",
      "invalid_api_key",
      "Invalid API key provided",
    );
  }

  const { id: runId } = await params;

  // Verify run exists and belongs to user
  const [run] = await globalThis.services.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return createErrorResponse(
      404,
      "not_found_error",
      "resource_not_found",
      `No such run: '${runId}'`,
    );
  }

  // Verify ownership
  if (run.userId !== auth.userId) {
    return createErrorResponse(
      404,
      "not_found_error",
      "resource_not_found",
      `No such run: '${runId}'`,
    );
  }

  // Get lastEventId from query for reconnection support
  const url = new URL(request.url);
  const lastEventId = url.searchParams.get("lastEventId");
  let lastSequence = lastEventId ? parseInt(lastEventId, 10) : 0;

  // Create SSE stream
  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      let lastStatus = run.status;
      let lastHeartbeat = Date.now();

      // Send initial status event
      controller.enqueue(
        encoder.encode(
          formatSSE("status", {
            status: lastStatus,
            run_id: runId,
          }),
        ),
      );

      // If run is already in terminal state, send complete and close
      if (TERMINAL_STATUSES.includes(run.status)) {
        const result = run.result as RunResult | null;
        controller.enqueue(
          encoder.encode(
            formatSSE("complete", {
              status: run.status,
              output: result?.output ?? null,
              error: run.error ?? null,
            }),
          ),
        );
        controller.close();
        return;
      }

      // Poll for updates
      const poll = async () => {
        if (isClosed) return;

        // Fetch latest run status
        const [currentRun] = await globalThis.services.db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1);

        if (!currentRun) {
          controller.enqueue(
            encoder.encode(
              formatSSE("error", {
                message: "Run not found",
                code: "run_not_found",
              }),
            ),
          );
          controller.close();
          isClosed = true;
          return;
        }

        // Send status update if changed
        if (currentRun.status !== lastStatus) {
          lastStatus = currentRun.status;
          controller.enqueue(
            encoder.encode(
              formatSSE("status", {
                status: lastStatus,
                run_id: runId,
              }),
            ),
          );
        }

        // Fetch new agent events from Axiom
        const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
        const apl = `['${dataset}']
| where runId == "${runId}"
| where sequenceNumber > ${lastSequence}
| order by sequenceNumber asc
| limit 100`;

        const events = await queryAxiom<AxiomAgentEvent>(apl);

        if (events && events.length > 0) {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(
                formatSSE(
                  "output",
                  {
                    sequence: event.sequenceNumber,
                    type: event.eventType,
                    data: event.eventData,
                    timestamp: event._time,
                  },
                  String(event.sequenceNumber),
                ),
              ),
            );
            lastSequence = event.sequenceNumber;
          }
        }

        // Send heartbeat if needed
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          controller.enqueue(
            encoder.encode(
              formatSSE("heartbeat", {
                timestamp: new Date().toISOString(),
              }),
            ),
          );
          lastHeartbeat = now;
        }

        // Check if run completed
        if (TERMINAL_STATUSES.includes(currentRun.status)) {
          const result = currentRun.result as RunResult | null;
          controller.enqueue(
            encoder.encode(
              formatSSE("complete", {
                status: currentRun.status,
                output: result?.output ?? null,
                error: currentRun.error ?? null,
              }),
            ),
          );
          controller.close();
          isClosed = true;
          return;
        }

        // Schedule next poll
        setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };

      // Start polling
      setTimeout(() => void poll(), POLL_INTERVAL_MS);
    },
    cancel() {
      isClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
