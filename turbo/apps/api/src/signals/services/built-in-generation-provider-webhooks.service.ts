import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";

type BuiltInGenerationProviderWebhookProvider = "fal";

function webhookTokenPayload(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey: string | undefined;
}): string {
  return [args.provider, args.generationId, args.visualKey ?? ""].join(":");
}

function signBuiltInGenerationProviderWebhookToken(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      webhookTokenPayload({
        provider: args.provider,
        generationId: args.generationId,
        visualKey: args.visualKey,
      }),
    )
    .digest("hex");
}

export function verifyBuiltInGenerationProviderWebhookToken(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey: string | undefined;
  readonly token: string;
}): boolean {
  const expected = signBuiltInGenerationProviderWebhookToken({
    provider: args.provider,
    generationId: args.generationId,
    visualKey: args.visualKey,
  });
  const actual = Buffer.from(args.token);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actual, expectedBuffer);
}

export function falBuiltInGenerationWebhookUrl(args: {
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  const baseUrl = new URL(
    `/api/webhooks/built-in-generations/fal/${args.generationId}`,
    env("VM0_API_URL"),
  );
  baseUrl.searchParams.set(
    "token",
    signBuiltInGenerationProviderWebhookToken({
      provider: "fal",
      generationId: args.generationId,
      visualKey: args.visualKey,
    }),
  );
  if (args.visualKey) {
    baseUrl.searchParams.set("visualKey", args.visualKey);
  }
  return baseUrl.toString();
}
