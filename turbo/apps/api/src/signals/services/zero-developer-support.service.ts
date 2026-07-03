import { createHmac, hkdfSync } from "node:crypto";

import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { developerSupportBodySchema } from "@vm0/api-contracts/contracts/zero-developer-support";
import { agentRuns } from "@vm0/db/schema/agent-run";
import type { z } from "zod";

import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
import { db$ } from "../external/db";
import { submitDiagnosticBundle } from "./diagnostic-bundle.service";

type DeveloperSupportBody = z.infer<typeof developerSupportBodySchema>;

interface SubmitDeveloperSupportArgs extends DeveloperSupportBody {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}

type SubmitDeveloperSupportResult =
  | { readonly kind: "consent_code"; readonly consentCode: string }
  | { readonly kind: "ok"; readonly reference: string }
  | { readonly kind: "run_not_found" }
  | { readonly kind: "invalid_consent_code" };

const consentKey = singleton((): Buffer => {
  const masterKey = Buffer.from(env("SECRETS_ENCRYPTION_KEY"), "hex");
  return Buffer.from(
    hkdfSync("sha256", masterKey, "", "developer-support-consent", 32),
  );
});

function generateConsentCode(seed: string): string {
  return createHmac("sha256", consentKey())
    .update(seed)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
}

export const submitZeroDeveloperSupport$ = command(
  async (
    { get },
    args: SubmitDeveloperSupportArgs,
    signal: AbortSignal,
  ): Promise<SubmitDeveloperSupportResult> => {
    const db = get(db$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        error: agentRuns.error,
        prompt: agentRuns.prompt,
        appendSystemPrompt: agentRuns.appendSystemPrompt,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        lastEventSequence: agentRuns.lastEventSequence,
        agentComposeVersionId: agentRuns.agentComposeVersionId,
        runnerGroup: agentRuns.runnerGroup,
        continuedFromSessionId: agentRuns.continuedFromSessionId,
        result: agentRuns.result,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return { kind: "run_not_found" };
    }

    const consentSeed = run.continuedFromSessionId ?? args.runId;
    const expectedConsentCode = generateConsentCode(consentSeed);

    if (!args.consentCode) {
      return { kind: "consent_code", consentCode: expectedConsentCode };
    }

    if (args.consentCode !== expectedConsentCode) {
      return { kind: "invalid_consent_code" };
    }

    const { reference } = await get(
      submitDiagnosticBundle({
        title: args.title,
        description: args.description,
        userId: args.userId,
        orgId: args.orgId,
        runId: args.runId,
        run,
        referencePrefix: "ds",
        s3PathPrefix: "developer-support",
        emailSubjectPrefix: "[Developer Support]",
      }),
    );
    signal.throwIfAborted();

    return { kind: "ok", reference };
  },
);
