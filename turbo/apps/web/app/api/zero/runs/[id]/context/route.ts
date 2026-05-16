import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroRunContextContract,
  type RunContextResponse,
} from "@vm0/api-contracts/contracts/zero-runs";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getRunById } from "../../../../../../src/lib/infra/run/run-service";
import { queryRunContext } from "../../../../../../src/lib/infra/run/run-context-service";

// Older Axiom snapshots can contain null entries inside fields the contract
// types as Record<string, string|boolean> (e.g. environment variables that
// were never set). Drop them at the response boundary so ts-rest validation
// does not reject historical data.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function sanitizeBooleanRecord(
  value: unknown,
): Record<string, boolean> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function networkPolicyValue(
  value: unknown,
): "allow" | "deny" | "ask" | undefined {
  return value === "allow" || value === "deny" || value === "ask"
    ? value
    : undefined;
}

function sanitizeNetworkPolicies(
  value: unknown,
): RunContextResponse["networkPolicies"] {
  if (!isRecord(value)) return null;
  const policies: NonNullable<RunContextResponse["networkPolicies"]> = {};
  for (const [name, rawPolicy] of Object.entries(value)) {
    if (!isRecord(rawPolicy)) continue;
    const unknownPolicy = networkPolicyValue(rawPolicy.unknownPolicy);
    if (!unknownPolicy) continue;
    policies[name] = {
      allow: sanitizeStringArray(rawPolicy.allow),
      deny: sanitizeStringArray(rawPolicy.deny),
      ask: sanitizeStringArray(rawPolicy.ask),
      unknownPolicy,
    };
  }
  return Object.keys(policies).length > 0 ? policies : null;
}

const router = tsr.router(zeroRunContextContract, {
  getContext: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const run = await getRunById(params.id, userId, org.orgId);
    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    const snapshot = await queryRunContext(params.id);
    if (!snapshot) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Run context not available",
            code: "NOT_FOUND",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        prompt: snapshot.prompt,
        appendSystemPrompt: snapshot.appendSystemPrompt,
        runId: params.id,
        sessionId: snapshot.sessionId ?? null,
        secretNames: snapshot.secretNames,
        vars: (run.vars as Record<string, string> | undefined) ?? null,
        environment: sanitizeStringRecord(snapshot.environment),
        firewalls: snapshot.firewalls,
        networkPolicies: sanitizeNetworkPolicies(snapshot.networkPolicies),
        volumes: snapshot.volumes,
        artifact: snapshot.artifact,
        featureFlags: sanitizeBooleanRecord(snapshot.featureFlags),
      },
    };
  },
});

const handler = createHandler(zeroRunContextContract, router, {
  routeName: "zero.runs.context",
});

export { handler as GET };
