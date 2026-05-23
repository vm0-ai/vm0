import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { getVercelOidcToken } from "@vercel/oidc";
import { generateImageContract } from "@vm0/api-contracts/contracts/generate-image";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { ExternalAccountClient } from "google-auth-library";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { env } from "../../lib/env";
import type { RouteEntry } from "../route";
import { processOrgUsageEvents$ } from "../services/zero-credit-usage.service";

const MODEL = "gemini-2.5-flash-image";
const USAGE_KIND = "image";
const USAGE_PROVIDER = MODEL;
const USAGE_CATEGORY = "output_image";

interface GeneratedImage {
  readonly mimeType: string;
  readonly base64: string;
}

interface InlineDataPart {
  readonly inlineData: {
    readonly mimeType?: string;
    readonly data: string;
  };
}

interface CreditCheckRow extends Record<string, unknown> {
  readonly credits: string | null;
  readonly unsettled_expired: string | null;
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function badRequest(message: string) {
  return { status: 400 as const, body: errorBody(message, "BAD_REQUEST") };
}

function insufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

function serviceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

function hasInlineData(part: unknown): part is InlineDataPart {
  const inlineData =
    typeof part === "object" && part !== null && "inlineData" in part
      ? (part as { readonly inlineData?: unknown }).inlineData
      : undefined;

  return (
    typeof inlineData === "object" &&
    inlineData !== null &&
    "data" in inlineData &&
    typeof (inlineData as { readonly data?: unknown }).data === "string"
  );
}

function buildClient(): GoogleGenAI | null {
  const allowDevKey = env("ENV") !== "production";
  const geminiApiKey = env("GEMINI_API_KEY");
  if (allowDevKey && geminiApiKey) {
    return new GoogleGenAI({ apiKey: geminiApiKey });
  }

  const gcpProjectId = env("GCP_PROJECT_ID");
  const gcpProjectNumber = env("GCP_PROJECT_NUMBER");
  const gcpServiceAccountEmail = env("GCP_SERVICE_ACCOUNT_EMAIL");
  const gcpWorkloadIdentityPoolId = env("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const gcpWorkloadIdentityPoolProviderId = env(
    "GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID",
  );

  if (
    !gcpProjectId ||
    !gcpProjectNumber ||
    !gcpServiceAccountEmail ||
    !gcpWorkloadIdentityPoolId ||
    !gcpWorkloadIdentityPoolProviderId
  ) {
    return null;
  }

  const authClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${gcpProjectNumber}/locations/global/workloadIdentityPools/${gcpWorkloadIdentityPoolId}/providers/${gcpWorkloadIdentityPoolProviderId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${gcpServiceAccountEmail}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: async () => {
        return await getVercelOidcToken();
      },
    },
  });

  if (!authClient) {
    throw new Error("Failed to construct ExternalAccountClient");
  }

  return new GoogleGenAI({
    vertexai: true,
    project: gcpProjectId,
    location: "us-central1",
    googleAuthOptions: { authClient },
  });
}

const generateImageBody$ = bodyResultOf(generateImageContract.post);

const checkImageCredits$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const { rows } = await writeDb.execute<CreditCheckRow>(sql`
      WITH org AS (
        SELECT credits FROM org_metadata
        WHERE org_id = ${args.orgId}
        LIMIT 1
      ),
      expired AS (
        SELECT COALESCE(SUM(remaining), 0)::bigint AS total
        FROM credit_expires_record
        WHERE org_id = ${args.orgId}
          AND expires_at <= now()
          AND remaining > 0
      )
      SELECT
        (SELECT credits FROM org) AS credits,
        (SELECT total FROM expired) AS unsettled_expired
    `);
    signal.throwIfAborted();

    const row = rows[0];
    if (!row || row.credits === null) {
      return false;
    }

    const credits = Number(row.credits);
    const unsettledExpired = Number(row.unsettled_expired ?? 0);
    return credits - unsettledExpired > 0;
  },
);

const postGenerateImageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const ai = buildClient();
    if (!ai) {
      return serviceUnavailable(
        "Gemini image generation is not configured",
        "NOT_CONFIGURED",
      );
    }

    const bodyResult = await get(generateImageBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const prompt =
      typeof bodyResult.data.prompt === "string" ? bodyResult.data.prompt : "";
    if (prompt.trim().length === 0) {
      return badRequest("prompt is required and must be a non-empty string");
    }

    const hasCredits = await set(
      checkImageCredits$,
      { orgId: auth.orgId },
      signal,
    );
    if (!hasCredits) {
      return insufficientCredits();
    }

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    signal.throwIfAborted();

    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const images: GeneratedImage[] = parts.filter(hasInlineData).map((part) => {
      return {
        mimeType: part.inlineData.mimeType ?? "image/png",
        base64: part.inlineData.data,
      };
    });

    if (images.length === 0) {
      return badGateway("Model returned no image data", "NO_IMAGE_RETURNED");
    }

    const writeDb = set(writeDb$);
    await writeDb.insert(usageEvent).values({
      runId: null,
      idempotencyKey: randomUUID(),
      orgId: auth.orgId,
      userId: auth.userId,
      kind: USAGE_KIND,
      provider: USAGE_PROVIDER,
      category: USAGE_CATEGORY,
      quantity: images.length,
    });
    signal.throwIfAborted();

    waitUntil(set(processOrgUsageEvents$, auth.orgId, signal));

    return { status: 200 as const, body: { images } };
  },
);

export const generateImageRoutes: readonly RouteEntry[] = [
  {
    route: generateImageContract.post,
    handler: authRoute({ requireOrganization: true }, postGenerateImageInner$),
  },
];
