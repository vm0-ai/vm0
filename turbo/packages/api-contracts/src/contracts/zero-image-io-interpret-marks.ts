import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// Shared so the UI can enforce the same bounds it validates against and the two
// can't drift.
export const ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS = 16;
export const ZERO_IMAGE_INTERPRET_MARKS_MAX_INSTRUCTION_LENGTH = 2000;

export const zeroImageIoInterpretMarksRegionSchema = z.object({
  id: z.string().min(1),
  // The number drawn on the image for this region (1-based).
  mark: z.number().int().min(1),
  instruction: z
    .string()
    .min(1)
    .max(ZERO_IMAGE_INTERPRET_MARKS_MAX_INSTRUCTION_LENGTH),
  location: z.string().max(500).optional(),
});
export type ZeroImageIoInterpretMarksRegion = z.infer<
  typeof zeroImageIoInterpretMarksRegionSchema
>;

export const zeroImageIoInterpretMarksRequestSchema = z.object({
  // Data URI or URL of the source image with numbered marks drawn on it.
  imageUrl: z.string().min(1),
  regions: z
    .array(zeroImageIoInterpretMarksRegionSchema)
    .min(1)
    .max(ZERO_IMAGE_INTERPRET_MARKS_MAX_REGIONS)
    .readonly(),
});
export type ZeroImageIoInterpretMarksRequest = z.infer<
  typeof zeroImageIoInterpretMarksRequestSchema
>;

export const zeroImageIoInterpretMarksResultSchema = z.object({
  id: z.string(),
  // The disambiguated object/area the mark refers to, e.g. "the dog's black
  // nose in the centre (not the tongue below it)".
  target: z.string(),
  // The self-contained edit instruction to apply to that target.
  edit: z.string(),
  confidence: z.number().min(0).max(100),
});
export type ZeroImageIoInterpretMarksResult = z.infer<
  typeof zeroImageIoInterpretMarksResultSchema
>;

export const zeroImageIoInterpretMarksResponseSchema = z.object({
  regions: z.array(zeroImageIoInterpretMarksResultSchema),
});
export type ZeroImageIoInterpretMarksResponse = z.infer<
  typeof zeroImageIoInterpretMarksResponseSchema
>;

export const zeroImageIoInterpretMarksContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/image-io/interpret-marks",
    headers: authHeadersSchema,
    body: zeroImageIoInterpretMarksRequestSchema,
    responses: {
      200: zeroImageIoInterpretMarksResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Interpret numbered region marks into targeted edit instructions",
  },
});

export type ZeroImageIoInterpretMarksContract =
  typeof zeroImageIoInterpretMarksContract;
