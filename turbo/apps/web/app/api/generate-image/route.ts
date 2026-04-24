import { GoogleGenAI } from "@google/genai";
import { getVercelOidcToken } from "@vercel/oidc";
import { randomUUID } from "crypto";
import { ExternalAccountClient } from "google-auth-library";
import { after, NextRequest, NextResponse } from "next/server";
import { usageEvent } from "../../../src/db/schema/usage-event";
import { env } from "../../../src/env";
import { getAuthContext } from "../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../src/lib/init-services";
import { isApiError } from "../../../src/lib/shared/errors";
import { processOrgUsageEvents } from "../../../src/lib/zero/credit/usage-event-service";
import { resolveOrg } from "../../../src/lib/zero/org/resolve-org";
import { checkOrgCredits } from "../../../src/lib/zero/zero-run-policy";

export const runtime = "nodejs";

const MODEL = "gemini-2.5-flash-image";
// usage_event row shape. Pricing lives in usage_pricing keyed by the same
// (kind, provider, category) triple; see scripts/dev-seed.ts.
const USAGE_KIND = "image";
const USAGE_PROVIDER = MODEL;
const USAGE_CATEGORY = "output_image";

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

// Production is always Vertex AI via Vercel OIDC → GCP Workload Identity
// Federation → SA impersonation — no static credentials exist by design,
// and a stray GEMINI_API_KEY must not quietly divert charges to a second
// billing account. Preview/dev may opt into the Gemini Developer API path
// as a convenience so one shared key in 1Password works without gcloud.
function buildClient(): GoogleGenAI | null {
  if (cachedClient) return cachedClient;

  const validated = env();
  const allowDevKey = validated.VERCEL_ENV !== "production";

  if (allowDevKey && validated.GEMINI_API_KEY) {
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
  try {
    return await handlePost(req);
  } catch (error) {
    if (isApiError(error)) {
      return NextResponse.json(
        { error: { message: error.message, code: error.code } },
        { status: error.statusCode },
      );
    }
    throw error;
  }
}

async function handlePost(req: NextRequest) {
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
  await checkOrgCredits(org.orgId, userId, "vm0", db);

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

  // Record the billable event only after Vertex succeeds. `idempotencyKey`
  // is required by the schema but serves as a per-row uniqueness tag here,
  // not a client-facing retry key — clients do not send one. Settle inline
  // via after() so the org balance reflects the charge before the next
  // request lands.
  await db.insert(usageEvent).values({
    runId: null,
    idempotencyKey: randomUUID(),
    orgId: org.orgId,
    userId,
    kind: USAGE_KIND,
    provider: USAGE_PROVIDER,
    category: USAGE_CATEGORY,
    quantity: images.length,
  });

  after(() => {
    return processOrgUsageEvents(org.orgId);
  });

  return NextResponse.json({ images });
}
