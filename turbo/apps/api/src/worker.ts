import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";

import { createProductionApp } from "./production-bootstrap";
import { cloudflareAccessHeadersForApiUrl } from "./lib/cloudflare-access";
import { env } from "./lib/env";
import { runInvocation } from "./lib/invocation-context";
import { WORKER_CRON_ROUTES } from "./worker-crons";

const MAX_CONCURRENT_CRON_ROUTES = 6;
const app = createProductionApp();

interface WorkerVersionMetadata {
  readonly id: string;
}

interface WorkerBindings {
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
  readonly [name: string]: string | WorkerVersionMetadata | undefined;
}

interface WorkerExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}

interface WorkerScheduledController {
  readonly cron: string;
}

interface WorkerHandler {
  fetch(
    request: Request,
    bindings: WorkerBindings,
    executionContext: WorkerExecutionContext,
  ): Promise<Response>;
  scheduled(
    controller: WorkerScheduledController,
    bindings: WorkerBindings,
    executionContext: WorkerExecutionContext,
  ): Promise<void>;
}

function requestId(request?: Request): string {
  return request?.headers.get("cf-ray") ?? crypto.randomUUID();
}

async function dispatchCronRoute(path: string): Promise<void> {
  const url = new URL(
    path,
    env("VM0_API_BACKEND_URL") ?? env("VM0_WEB_URL"),
  ).toString();
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${env("CRON_SECRET")}`,
      ...cloudflareAccessHeadersForApiUrl(url),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  await response.body?.cancel();
}

async function dispatchCronSchedule(cron: string): Promise<void> {
  const paths = WORKER_CRON_ROUTES[cron];
  if (!paths) {
    throw new Error(`Unsupported Worker cron schedule: ${cron}`);
  }
  const errors: unknown[] = [];
  for (
    let index = 0;
    index < paths.length;
    index += MAX_CONCURRENT_CRON_ROUTES
  ) {
    const batch = paths.slice(index, index + MAX_CONCURRENT_CRON_ROUTES);
    const results = await Promise.allSettled(batch.map(dispatchCronRoute));
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} cron routes failed`);
  }
}

const traceConfig: ResolveConfigFn<WorkerBindings> = () => {
  return {
    exporter: {
      url: "https://api.axiom.co/v1/traces",
      headers: {
        authorization: `Bearer ${env("AXIOM_TOKEN_TELEMETRY")}`,
        "x-axiom-dataset": `vm0-traces-${env("AXIOM_DATASET_SUFFIX")}`,
      },
    },
    service: {
      name: "vm0-api",
      version: env("GIT_COMMIT_SHA"),
    },
    fetch: { includeTraceContext: false },
    handlers: { fetch: { acceptTraceContext: false } },
  };
};

export default instrument(
  {
    async fetch(request, bindings, executionContext): Promise<Response> {
      return await runInvocation(
        executionContext,
        {
          kind: "fetch",
          requestId: requestId(request),
          workerVersion: bindings.CF_VERSION_METADATA?.id,
        },
        async () => {
          return await app.fetch(request);
        },
      );
    },
    async scheduled(controller, bindings, executionContext): Promise<void> {
      await runInvocation(
        executionContext,
        {
          kind: "scheduled",
          requestId: requestId(),
          workerVersion: bindings.CF_VERSION_METADATA?.id,
        },
        async () => {
          await dispatchCronSchedule(controller.cron);
        },
      );
    },
  } satisfies WorkerHandler,
  traceConfig,
);
