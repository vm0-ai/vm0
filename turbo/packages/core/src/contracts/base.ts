/**
 * ts-rest contract initialization
 * Re-exported from @ts-rest/core for use in contract definitions
 */
import { z } from "zod";

export { initContract } from "@ts-rest/core";

/**
 * Shared headers schema for endpoints requiring authentication.
 * The authorization header is optional - endpoints handle missing auth
 * by returning 401 responses.
 *
 * NOTE: This uses z.object() despite @ts-rest expecting a plain object
 * for headers. This is intentional — with Zod 4, @ts-rest's
 * InferHeadersOutput type relies on z.AnyZodObject (which resolves to
 * `any` in Zod 4) to correctly infer z.output<T> for handler types.
 * Using a plain object breaks handler type inference (headers becomes {}).
 * The resulting TS2322 on contract definitions is a known @ts-rest + Zod 4
 * compatibility issue (https://github.com/ts-rest/ts-rest/issues/852).
 */
export const authHeadersSchema = z.object({
  authorization: z.string().optional(),
});
