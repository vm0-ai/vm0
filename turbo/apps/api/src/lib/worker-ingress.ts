import { env } from "./env";
import { currentInvocation } from "./invocation-context";

type WorkerIngress =
  | "not-worker"
  | "preview"
  | "production-public"
  | "production-candidate"
  | "unknown";

type WorkerOriginEnvName =
  | "CF_API_PUBLIC_ORIGIN"
  | "CF_API_PRODUCTION_CANDIDATE_ORIGIN";

function configuredOrigin(name: WorkerOriginEnvName): string | undefined {
  const value = env(name);
  return value ? new URL(value).origin : undefined;
}

export function workerIngressForUrl(url: string): WorkerIngress {
  if (!currentInvocation()) {
    return "not-worker";
  }
  if (env("ENV") === "preview") {
    return "preview";
  }
  if (env("ENV") !== "production") {
    return "unknown";
  }

  const origin = new URL(url).origin;
  if (origin === configuredOrigin("CF_API_PUBLIC_ORIGIN")) {
    return "production-public";
  }
  if (origin === configuredOrigin("CF_API_PRODUCTION_CANDIDATE_ORIGIN")) {
    return "production-candidate";
  }
  return "unknown";
}
