import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunContextContract } from "@vm0/api-contracts/contracts/zero-runs";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getRunById } from "../../../../../../src/lib/infra/run/run-service";
import { queryRunContext } from "../../../../../../src/lib/infra/run/run-context-service";

const router = tsr.router(zeroRunContextContract, {
  getContext: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
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
        environment: snapshot.environment,
        firewalls: snapshot.firewalls,
        networkPolicies: snapshot.networkPolicies ?? null,
        volumes: snapshot.volumes,
        artifact: snapshot.artifact,
        featureFlags: snapshot.featureFlags,
      },
    };
  },
});

const handler = createHandler(zeroRunContextContract, router, {
  routeName: "zero.runs.context",
});

export { handler as GET };
