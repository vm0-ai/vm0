import { GoogleGenAI } from "@google/genai";
import { getVercelOidcToken } from "@vercel/oidc";
import { randomUUID } from "crypto";
import { ExternalAccountClient } from "google-auth-library";
import { NextRequest, NextResponse } from "next/server";
import { creditUsage } from "../../../src/db/schema/credit-usage";
import { env } from "../../../src/env";
import { getAuthContext } from "../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../src/lib/init-services";
import { isApiError } from "../../../src/lib/shared/errors";
import { resolveOrg } from "../../../src/lib/zero/org/resolve-org";
import { checkOrgCredits } from "../../../src/lib/zero/zero-run-policy";

export const runtime = "nodejs";

const MODEL = "gemini-2.5-flash-image";
// Treated as a vm0-bundled model so checkOrgCredits() and the process-credits
// cron both engage; pricing lives in credit_pricing keyed by this pair.
const MODEL_PROVIDER = "vm0";

interface GeneratedImage {
  mimeType: string;
  base64: string;
}

interface InlineDataPart {
  inlineData: {
    mimeType?: string;
    data: string;
  };
}

function hasInlineData(part: unknown): part is InlineDataPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "inlineData" in part &&
    typeof (part as { inlineData?: unknown }).inlineData === "object" &&
    (part as { inlineData?: { data?: unknown } }).inlineData?.data != null &&
    typeof (part as { inlineData: { data: unknown } }).inlineData.data ===
      "string"
  );
}

let cachedClient: GoogleGenAI | undefined;

// Prefer the Gemini Developer API key when present (local/dev: one shared
// string in 1Password, no gcloud required). Fall back to Vertex AI via
// Vercel OIDC → GCP Workload Identity Federation → SA impersonation on
// production, where no long-lived credential exists by design.
function buildClient(): GoogleGenAI | null {
  if (cachedClient) return cachedClient;

  const validated = env();

  if (validated.GEMINI_API_KEY) {
    cachedClient = new GoogleGenAI({ apiKey: validated.GEMINI_API_KEY });
    return cachedClient;
  }

  if (
    !validated.GCP_PROJECT_ID ||
    !validated.GCP_PROJECT_NUMBER ||
    !validated.GCP_SERVICE_ACCOUNT_EMAIL ||
    !validated.GCP_WORKLOAD_IDENTITY_POOL_ID ||
    !validated.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID
  ) {
    return null;
  }

  const authClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${validated.GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${validated.GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${validated.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${validated.GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: async () => {
        return await getVercelOidcToken();
      },
    },
  });

  if (!authClient) {
    throw new Error("Failed to construct ExternalAccountClient");
  }

  cachedClient = new GoogleGenAI({
    vertexai: true,
    project: validated.GCP_PROJECT_ID,
    location: "us-central1",
    googleAuthOptions: { authClient },
  });

  return cachedClient;
}

export async function POST(req: NextRequest) {
  initServices();

  const authCtx = await getAuthContext(
    req.headers.get("Authorization") ?? undefined,
  );
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const { userId } = authCtx;

  const ai = buildClient();
  if (!ai) {
    return NextResponse.json(
      {
        error: {
          message: "Gemini image generation is not configured",
          code: "NOT_CONFIGURED",
        },
      },
      { status: 503 },
    );
  }

  const body = (await req.json()) as { prompt?: unknown };
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return NextResponse.json(
      {
        error: {
          message: "prompt is required and must be a non-empty string",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }
  const prompt = body.prompt;

  const db = globalThis.services.db;
  const { org } = await resolveOrg(authCtx);

  try {
    await checkOrgCredits(org.orgId, userId, MODEL_PROVIDER, db);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const parts = result.candidates?.[0]?.content?.parts ?? [];
  const images: GeneratedImage[] = parts.filter(hasInlineData).map((part) => {
    return {
      mimeType: part.inlineData.mimeType ?? "image/png",
      base64: part.inlineData.data,
    };
  });

  if (images.length === 0) {
    return NextResponse.json(
      {
        error: {
          message: "Model returned no image data",
          code: "NO_IMAGE_RETURNED",
        },
      },
      { status: 502 },
    );
  }

  // Record pending credit_usage; the process-credits cron settles it later
  // against credit_pricing. A fresh messageId keeps each call under its own
  // row via the (run_id, message_id) unique index.
  await db.insert(creditUsage).values({
    runId: null,
    messageId: randomUUID(),
    orgId: org.orgId,
    userId,
    model: MODEL,
    modelProvider: MODEL_PROVIDER,
    inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
  });

  return NextResponse.json({ images });
}
