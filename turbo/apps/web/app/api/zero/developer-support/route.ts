import { createHmac, hkdfSync } from "crypto";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroDeveloperSupportContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { env } from "../../../../src/env";
import { submitDiagnosticBundle } from "../../../../src/lib/zero/support/diagnostic-bundle-service";

// Cache the derived HMAC key for the process lifetime
let cachedConsentKey: Buffer | null = null;

function getConsentKey(): Buffer {
  if (!cachedConsentKey) {
    const keyHex = env().SECRETS_ENCRYPTION_KEY;
    const masterKey = Buffer.from(keyHex, "hex");
    cachedConsentKey = Buffer.from(
      hkdfSync("sha256", masterKey, "", "developer-support-consent", 32),
    );
  }
  return cachedConsentKey;
}

function generateConsentCode(sessionId: string): string {
  const key = getConsentKey();
  return createHmac("sha256", key)
    .update(sessionId)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
}

const router = tsr.router(zeroDeveloperSupportContract, {
  submit: async ({ body, headers }) => {
    initServices();

    // acceptAnySandboxCapability: developer-support can be invoked from any
    // sandbox capability (cli, web, scheduled, etc.) -- there is no dedicated
    // capability for this endpoint.
    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;

    const { userId, orgId, runId } = authCtx;
    if (!runId || !orgId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "This endpoint requires a zero token with runId and orgId",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const db = globalThis.services.db;

    // Query run record early -- both consent steps need sessionId
    const [run] = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        error: agentRuns.error,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        runnerGroup: agentRuns.runnerGroup,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        result: agentRuns.result,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return {
        status: 400 as const,
        body: {
          error: { message: "Run not found", code: "RUN_NOT_FOUND" },
        },
      };
    }

    const sessionId = run.continuedFromSessionId;
    // Use sessionId for consent HMAC when available, fall back to runId for
    // first-run (no session yet) so developer-support works in single-turn too.
    const consentSeed = sessionId ?? runId;

    // Step 1: Generate consent code if none provided
    if (!body.consentCode) {
      const consentCode = generateConsentCode(consentSeed);
      return {
        status: 200 as const,
        body: { consentCode },
      };
    }

    // Step 2: Validate consent code
    const expectedCode = generateConsentCode(consentSeed);
    if (body.consentCode !== expectedCode) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: "Invalid consent code",
            code: "INVALID_CONSENT_CODE",
          },
        },
      };
    }

    const { reference } = await submitDiagnosticBundle({
      title: body.title,
      description: body.description,
      userId,
      orgId,
      runId,
      run,
      referencePrefix: "ds",
      s3PathPrefix: "developer-support",
      emailSubjectPrefix: "[Developer Support]",
    });

    return {
      status: 200 as const,
      body: { reference },
    };
  },
});

const handler = createHandler(zeroDeveloperSupportContract, router, {
  routeName: "zero.developer-support",
});

export { handler as POST };
