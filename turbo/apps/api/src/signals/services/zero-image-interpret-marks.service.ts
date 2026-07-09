import type {
  ZeroImageIoInterpretMarksRegion,
  ZeroImageIoInterpretMarksResult,
} from "@vm0/api-contracts/contracts/zero-image-io-interpret-marks";

import { logger } from "../../lib/log";
import {
  generateText,
  isLlmConfigured,
  type OpenRouterContentPart,
} from "../external/openrouter";
import { safeJsonParse, settle } from "../utils";

const log = logger("api:zero-image-interpret-marks");
const INTERPRET_MARKS_MODEL = "google/gemini-3.5-flash";
// Sized for the max 16 regions (each ~a few short strings); a too-small budget
// truncates the JSON (finish_reason "length"), which makes generateText throw
// and collapses the whole batch to the raw-instruction fallback.
const INTERPRET_MARKS_MAX_TOKENS = 4000;

const INTERPRET_MARKS_SYSTEM_PROMPT = [
  "You localize numbered marks drawn on an image for a downstream image editor that cannot see the marks.",
  "The image has numbered rectangular outlines (1, 2, 3, ...). Each number maps to one edit instruction supplied by the user.",
  "For every number, name the specific object or area the outline covers, and disambiguate it from nearby objects (e.g. 'the black nose, not the tongue below it').",
  "Rewrite each instruction into a single self-contained sentence that a text-only editor can follow, referencing the target by that description.",
  "Do not invent regions. Return exactly one result per input region, keyed by the same id.",
  "Return strict JSON only, no prose, no code fences.",
].join("\n");

function fallbackResult(
  region: ZeroImageIoInterpretMarksRegion,
): ZeroImageIoInterpretMarksResult {
  return {
    id: region.id,
    target: "",
    edit: region.instruction,
    confidence: 0,
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  return safeJsonParse(candidate);
}

function parseResults(
  generated: string,
  regions: readonly ZeroImageIoInterpretMarksRegion[],
): ZeroImageIoInterpretMarksResult[] | null {
  const parsed = extractJsonObject(generated);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("regions" in parsed) ||
    !Array.isArray(parsed.regions)
  ) {
    return null;
  }
  const byId = new Map<string, unknown>();
  for (const entry of parsed.regions) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string"
    ) {
      byId.set(entry.id, entry);
    }
  }
  return regions.map((region) => {
    const entry = byId.get(region.id);
    if (typeof entry !== "object" || entry === null) {
      return fallbackResult(region);
    }
    const target =
      "target" in entry && typeof entry.target === "string" ? entry.target : "";
    const edit =
      "edit" in entry && typeof entry.edit === "string" && entry.edit.trim()
        ? entry.edit.trim()
        : region.instruction;
    const rawConfidence =
      "confidence" in entry && typeof entry.confidence === "number"
        ? entry.confidence
        : 0;
    const confidence = Math.max(0, Math.min(100, rawConfidence));
    return { id: region.id, target, edit, confidence };
  });
}

export async function interpretRegionMarks(args: {
  readonly imageUrl: string;
  readonly regions: readonly ZeroImageIoInterpretMarksRegion[];
}): Promise<ZeroImageIoInterpretMarksResult[]> {
  const fallback = args.regions.map(fallbackResult);
  if (!isLlmConfigured()) {
    return fallback;
  }

  const userText = JSON.stringify(
    {
      regions: args.regions.map((region) => {
        return {
          id: region.id,
          mark: region.mark,
          instruction: region.instruction,
          approximateLocation: region.location,
        };
      }),
      outputSchema: {
        regions:
          "Array<{ id: string (echo the input id for the region whose 'mark' number is drawn on the image), target: string (the disambiguated object/area the mark covers), edit: string (one self-contained edit instruction), confidence: 0-100 }>",
      },
    },
    null,
    2,
  );

  const content: OpenRouterContentPart[] = [
    { type: "text", text: userText },
    { type: "image_url", image_url: { url: args.imageUrl } },
  ];

  const generated = await settle(
    generateText(
      INTERPRET_MARKS_MODEL,
      [
        { role: "system", content: INTERPRET_MARKS_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      INTERPRET_MARKS_MAX_TOKENS,
    ),
  );

  if (!generated.ok) {
    log.warn("Failed to interpret region marks", {
      error:
        generated.error instanceof Error
          ? generated.error.message
          : String(generated.error),
    });
    return fallback;
  }
  if (generated.value === null) {
    return fallback;
  }

  const results = parseResults(generated.value, args.regions);
  if (results === null) {
    log.warn("Region mark interpretation returned unparseable JSON");
    return fallback;
  }
  return results;
}
