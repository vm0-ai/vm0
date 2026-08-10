import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers";

import { singleton } from "./lib/singleton";
import { resolveRuntimeEnv } from "./lib/worker-env";
import { WORKER_CRON_ROUTES } from "./worker-crons";

const MAX_CONCURRENT_CRON_ROUTES = 6;

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

async function createRuntime() {
  const [bootstrap, access, environment, invocation] = await Promise.all([
    import("./production-bootstrap"),
    import("./lib/cloudflare-access"),
    import("./lib/env"),
    import("./lib/invocation-context"),
  ]);
  return {
    app: bootstrap.createProductionApp(),
    cloudflareAccessHeadersForApiUrl: access.cloudflareAccessHeadersForApiUrl,
    env: environment.env,
    runInvocation: invocation.runInvocation,
  };
}

type WorkerRuntime = Awaited<ReturnType<typeof createRuntime>>;

const loadRuntime = singleton<Promise<WorkerRuntime>>(createRuntime);

async function installRuntimeEnv(bindings: WorkerBindings): Promise<void> {
  const environment = await import("./lib/env");
  environment.installWorkerRuntimeEnv(bindings);
}

function requestId(request?: Request): string {
  return request?.headers.get("cf-ray") ?? crypto.randomUUID();
}

async function dispatchCronRoute(
  runtime: WorkerRuntime,
  path: string,
): Promise<void> {
  const url = new URL(
    path,
    runtime.env("VM0_API_BACKEND_URL") ?? runtime.env("VM0_WEB_URL"),
  ).toString();
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${runtime.env("CRON_SECRET")}`,
      ...runtime.cloudflareAccessHeadersForApiUrl(url),
    },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  await response.body?.cancel();
}

async function dispatchCronSchedule(
  runtime: WorkerRuntime,
  cron: string,
): Promise<void> {
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
    const results = await Promise.allSettled(
      batch.map(async (path) => {
        await dispatchCronRoute(runtime, path);
      }),
    );
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

const traceConfig: ResolveConfigFn<WorkerBindings> = (bindings) => {
  const runtimeEnv = resolveRuntimeEnv(bindings);
  return {
    exporter: {
      url: "https://api.axiom.co/v1/traces",
      headers: {
        authorization: `Bearer ${runtimeEnv.AXIOM_TOKEN_TELEMETRY}`,
        "x-axiom-dataset": `vm0-traces-${runtimeEnv.AXIOM_DATASET_SUFFIX}`,
      },
    },
    service: {
      name: "vm0-api",
      version: runtimeEnv.GIT_COMMIT_SHA,
    },
    fetch: { includeTraceContext: false },
    handlers: { fetch: { acceptTraceContext: false } },
  };
};

export default instrument(
  {
    async fetch(request, bindings, executionContext): Promise<Response> {
      await installRuntimeEnv(bindings);
      const runtime = await loadRuntime();
      return await runtime.runInvocation(
        executionContext,
        {
          kind: "fetch",
          requestId: requestId(request),
          workerVersion: bindings.CF_VERSION_METADATA?.id,
        },
        async () => {
          return await runtime.app.fetch(request);
        },
      );
    },
    async scheduled(controller, bindings, executionContext): Promise<void> {
      await installRuntimeEnv(bindings);
      const runtime = await loadRuntime();
      await runtime.runInvocation(
        executionContext,
        {
          kind: "scheduled",
          requestId: requestId(),
          workerVersion: bindings.CF_VERSION_METADATA?.id,
        },
        async () => {
          await dispatchCronSchedule(runtime, controller.cron);
        },
      );
    },
  } satisfies WorkerHandler,
  traceConfig,
);
