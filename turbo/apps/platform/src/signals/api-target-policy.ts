import type { ApiHostTarget } from "./api-base.ts";

type ApiRouteMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

interface ApiTargetRequest {
  readonly method: string;
  readonly pathname: string;
}

interface ApiRouteAllowlistEntry {
  readonly methods: readonly ApiRouteMethod[];
  // Exact pathname, or a template with `:param` segments (each `:param`
  // matches exactly one non-empty path segment, e.g. "/api/zero/runs/:id").
  readonly pathname: string;
}

// First-party apps/platform routes that resolve to the dedicated `api` host
// while the global `apiBackend` switch is off. Everything not listed here
// defaults to `www`. Routes are method-aware: a path's mutations are migrated
// only when their method is listed. OAuth start/callbacks and device-auth
// flows, bootstrap feature-switches, and web-origin navigation flows are
// intentionally absent and stay on `www`.
const API_ROUTE_ALLOWLIST: readonly ApiRouteAllowlistEntry[] = [
  { methods: ["GET", "POST"], pathname: "/api/zero/agents" },
  {
    methods: ["GET", "PUT", "PATCH", "DELETE"],
    pathname: "/api/zero/agents/:id",
  },
  {
    methods: ["GET", "PUT"],
    pathname: "/api/zero/agents/:id/custom-connectors",
  },
  { methods: ["GET", "PUT"], pathname: "/api/zero/agents/:id/instructions" },
  { methods: ["GET", "PUT"], pathname: "/api/zero/agents/:id/user-connectors" },
  { methods: ["GET", "POST"], pathname: "/api/zero/api-keys" },
  { methods: ["DELETE"], pathname: "/api/zero/api-keys/:id" },
  { methods: ["POST"], pathname: "/api/zero/attribution/signup" },
  { methods: ["GET", "PUT"], pathname: "/api/zero/billing/auto-recharge" },
  { methods: ["POST"], pathname: "/api/zero/billing/checkout" },
  { methods: ["POST"], pathname: "/api/zero/billing/checkout/complete" },
  { methods: ["POST"], pathname: "/api/zero/billing/credit-checkout" },
  { methods: ["POST"], pathname: "/api/zero/billing/downgrade" },
  { methods: ["GET"], pathname: "/api/zero/billing/invoices" },
  { methods: ["POST"], pathname: "/api/zero/billing/portal" },
  { methods: ["POST"], pathname: "/api/zero/billing/redeem/:campaign" },
  { methods: ["GET"], pathname: "/api/zero/billing/status" },
  { methods: ["GET", "POST"], pathname: "/api/zero/chat-threads" },
  {
    methods: ["GET", "PATCH", "DELETE"],
    pathname: "/api/zero/chat-threads/:id",
  },
  { methods: ["POST"], pathname: "/api/zero/chat-threads/:id/mark-read" },
  { methods: ["POST"], pathname: "/api/zero/chat-threads/:id/pin" },
  { methods: ["POST"], pathname: "/api/zero/chat-threads/:id/rename" },
  { methods: ["POST"], pathname: "/api/zero/chat-threads/:id/unpin" },
  {
    methods: ["GET", "POST"],
    pathname: "/api/zero/chat-threads/:threadId/artifacts",
  },
  { methods: ["GET"], pathname: "/api/zero/chat-threads/:threadId/github-prs" },
  { methods: ["GET"], pathname: "/api/zero/chat-threads/:threadId/messages" },
  { methods: ["POST"], pathname: "/api/zero/chat/messages" },
  { methods: ["GET"], pathname: "/api/zero/chat/search" },
  { methods: ["GET"], pathname: "/api/zero/composes" },
  { methods: ["GET", "DELETE"], pathname: "/api/zero/composes/:id" },
  { methods: ["PATCH"], pathname: "/api/zero/composes/:id/metadata" },
  { methods: ["GET"], pathname: "/api/zero/composes/list" },
  { methods: ["GET"], pathname: "/api/zero/connectors" },
  { methods: ["GET", "DELETE"], pathname: "/api/zero/connectors/:type" },
  { methods: ["POST"], pathname: "/api/zero/connectors/:type/manual-grant" },
  { methods: ["GET"], pathname: "/api/zero/connectors/:type/scope-diff" },
  { methods: ["GET"], pathname: "/api/zero/connectors/search" },
  { methods: ["GET", "POST"], pathname: "/api/zero/custom-connectors" },
  { methods: ["PATCH", "DELETE"], pathname: "/api/zero/custom-connectors/:id" },
  {
    methods: ["PUT", "DELETE"],
    pathname: "/api/zero/custom-connectors/:id/secret",
  },
  { methods: ["PUT"], pathname: "/api/zero/default-agent" },
  {
    methods: ["POST"],
    pathname: "/api/zero/host/presentation-html/redeploy",
  },
  { methods: ["GET"], pathname: "/api/zero/insights" },
  { methods: ["GET"], pathname: "/api/zero/insights/range" },
  { methods: ["GET", "DELETE"], pathname: "/api/zero/integrations/slack" },
  {
    methods: ["GET", "POST"],
    pathname: "/api/zero/integrations/slack/connect",
  },
  { methods: ["POST"], pathname: "/api/zero/integrations/slack/message" },
  {
    methods: ["POST"],
    pathname: "/api/zero/integrations/slack/upload-file/complete",
  },
  {
    methods: ["POST"],
    pathname: "/api/zero/integrations/slack/upload-file/init",
  },
  { methods: ["GET"], pathname: "/api/zero/logs" },
  { methods: ["GET"], pathname: "/api/zero/logs/:id" },
  { methods: ["GET"], pathname: "/api/zero/logs/search" },
  { methods: ["GET", "POST"], pathname: "/api/zero/me/model-providers" },
  { methods: ["DELETE"], pathname: "/api/zero/me/model-providers/:type" },
  { methods: ["GET"], pathname: "/api/zero/memory" },
  { methods: ["GET"], pathname: "/api/zero/memory/activity" },
  { methods: ["GET", "POST"], pathname: "/api/zero/model-providers" },
  { methods: ["DELETE"], pathname: "/api/zero/model-providers/:type" },
  { methods: ["POST"], pathname: "/api/zero/onboarding/setup" },
  { methods: ["GET"], pathname: "/api/zero/onboarding/status" },
  { methods: ["GET", "PUT"], pathname: "/api/zero/org" },
  { methods: ["POST"], pathname: "/api/zero/org/delete" },
  { methods: ["POST", "DELETE"], pathname: "/api/zero/org/invite" },
  { methods: ["POST"], pathname: "/api/zero/org/leave" },
  { methods: ["GET", "POST", "DELETE"], pathname: "/api/zero/org/logo" },
  { methods: ["GET", "PATCH", "DELETE"], pathname: "/api/zero/org/members" },
  {
    methods: ["POST", "DELETE"],
    pathname: "/api/zero/org/membership-requests",
  },
  { methods: ["POST"], pathname: "/api/zero/push-subscriptions" },
  { methods: ["GET"], pathname: "/api/zero/queue-position" },
  { methods: ["POST"], pathname: "/api/zero/realtime/token" },
  { methods: ["POST"], pathname: "/api/zero/report-error" },
  { methods: ["POST"], pathname: "/api/zero/runs" },
  { methods: ["GET"], pathname: "/api/zero/runs/:id" },
  { methods: ["POST"], pathname: "/api/zero/runs/:id/cancel" },
  { methods: ["GET"], pathname: "/api/zero/runs/:id/context" },
  { methods: ["GET"], pathname: "/api/zero/runs/:id/network" },
  { methods: ["GET"], pathname: "/api/zero/runs/:id/runner" },
  { methods: ["GET"], pathname: "/api/zero/runs/:id/telemetry/agent" },
  { methods: ["GET"], pathname: "/api/zero/runs/queue" },
  { methods: ["GET", "POST"], pathname: "/api/zero/schedules" },
  { methods: ["DELETE"], pathname: "/api/zero/schedules/:name" },
  { methods: ["POST"], pathname: "/api/zero/schedules/:name/disable" },
  { methods: ["POST"], pathname: "/api/zero/schedules/:name/enable" },
  { methods: ["POST"], pathname: "/api/zero/schedules/run" },
  { methods: ["GET", "POST"], pathname: "/api/zero/secrets" },
  { methods: ["DELETE"], pathname: "/api/zero/secrets/:name" },
  { methods: ["GET", "POST"], pathname: "/api/zero/skills" },
  { methods: ["GET", "PUT", "DELETE"], pathname: "/api/zero/skills/:name" },
  { methods: ["GET"], pathname: "/api/zero/slack/channels" },
  { methods: ["GET"], pathname: "/api/zero/team" },
  { methods: ["POST"], pathname: "/api/zero/uploads/complete" },
  { methods: ["POST"], pathname: "/api/zero/uploads/prepare" },
  { methods: ["GET"], pathname: "/api/zero/usage/insight" },
  { methods: ["GET"], pathname: "/api/zero/usage/members" },
  { methods: ["GET"], pathname: "/api/zero/usage/record" },
  { methods: ["GET", "PUT"], pathname: "/api/zero/user-permission-grants" },
  { methods: ["GET", "POST"], pathname: "/api/zero/user-preferences" },
  { methods: ["GET", "POST"], pathname: "/api/zero/variables" },
  { methods: ["DELETE"], pathname: "/api/zero/variables/:name" },
  { methods: ["GET"], pathname: "/api/zero/voice-io/quota" },
  { methods: ["POST"], pathname: "/api/zero/voice-io/stt" },
  { methods: ["POST"], pathname: "/api/zero/voice-io/tts" },
];

function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

// Matches an allowlist pathname template against a concrete request pathname.
// A `:param` template segment matches exactly one non-empty segment; all other
// segments must match literally and the segment counts must be equal.
function pathnameMatches(template: string, pathname: string): boolean {
  const templateSegments = template.split("/");
  const pathnameSegments = pathname.split("/");
  if (templateSegments.length !== pathnameSegments.length) {
    return false;
  }
  return templateSegments.every((segment, index) => {
    const actual = pathnameSegments[index];
    if (segment.startsWith(":")) {
      return actual.length > 0;
    }
    return segment === actual;
  });
}

export function resolveApiTarget(
  request: ApiTargetRequest,
  useApiBackend: boolean,
): ApiHostTarget {
  if (useApiBackend) {
    return "api";
  }

  const method = normalizeMethod(request.method);
  const allowed = API_ROUTE_ALLOWLIST.some((entry) => {
    return (
      pathnameMatches(entry.pathname, request.pathname) &&
      entry.methods.some((entryMethod) => {
        return entryMethod === method;
      })
    );
  });
  return allowed ? "api" : "www";
}
