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
 */
export const authHeadersSchema = z.object({
  authorization: z.string().optional(),
});
