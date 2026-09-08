import { HttpResponse } from "msw";
import { z } from "zod";

const modelRequestSchema = z.object({
  model: z.string(),
  reasoning: z.object({ effort: z.string() }).optional(),
});

/**
 * Exact-model capability snapshot from https://openrouter.ai/api/v1/models,
 * checked 2026-09-08: mandatory=true, supported_efforts=[high, medium, low],
 * default_effort=medium. No catalog request is made by deterministic tests.
 */
export function openRouterModelContractError(
  value: unknown,
): Response | undefined {
  const body = modelRequestSchema.parse(value);
  if (
    body.model === "google/gemini-3.8-flash" &&
    body.reasoning !== undefined &&
    !["high", "medium", "low"].includes(body.reasoning.effort)
  ) {
    return HttpResponse.json(
      { error: { code: "unsupported_value", param: "reasoning.effort" } },
      { status: 400 },
    );
  }
  return undefined;
}
