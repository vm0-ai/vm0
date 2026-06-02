import type { ApiHostTarget } from "./api-base.ts";

type ApiRouteMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

interface ApiTargetRequest {
  readonly method: string;
  readonly pathname: string;
}

interface ApiTargetPolicyEntry {
  readonly methods: readonly ApiRouteMethod[];
  readonly pathname: string;
  readonly target: ApiHostTarget;
}

const API_ROUTE_TARGET_POLICY: readonly ApiTargetPolicyEntry[] = [
  {
    methods: ["GET", "POST"],
    pathname: "/api/zero/user-preferences",
    target: "api",
  },
];

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

export function resolveApiTarget(
  request: ApiTargetRequest,
  useApiBackend: boolean,
): ApiHostTarget {
  if (useApiBackend) {
    return "api";
  }

  const method = normalizeMethod(request.method);
  const entry = API_ROUTE_TARGET_POLICY.find((candidate) => {
    return (
      candidate.pathname === request.pathname &&
      candidate.methods.some((candidateMethod) => {
        return candidateMethod === method;
      })
    );
  });
  return entry?.target ?? "www";
}
