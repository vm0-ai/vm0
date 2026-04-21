import { NextResponse } from "next/server";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero:voice-io:tts");

const MAX_TEXT_LENGTH = 4096;

const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

export async function POST(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.AudioOutput, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Audio output is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  const text =
    typeof body === "object" && body !== null && "text" in body
      ? (body as { text: unknown }).text
      : undefined;

  if (typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json(
      { error: { message: "text is required", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      {
        error: {
          message: `text must be at most ${MAX_TEXT_LENGTH} characters`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const apiKey = env().OPENAI_API_KEY;

  const response = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "ash",
      input: text,
      response_format: "pcm",
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("OpenAI TTS request failed", {
      status: response.status,
      body: errorBody,
    });
    return NextResponse.json(
      {
        error: {
          message: "TTS generation failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      { status: 500 },
    );
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });
}
