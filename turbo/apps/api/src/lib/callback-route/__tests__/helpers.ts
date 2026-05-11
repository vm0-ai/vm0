import { z } from "zod";
import { initContract } from "@ts-rest/core";

const c = initContract();

/**
 * Test-only contract used by callback-route tests to register a probe handler
 * via `createApp({ routes })`. The path is namespaced under `/api/__test__/`
 * so it never collides with a production route.
 */
export const callbackTestProbeContract = c.router({
  probe: {
    method: "POST",
    path: "/api/__test__/callback-route-probe",
    body: z.unknown(),
    responses: {
      200: z.object({ ok: z.literal(true), runId: z.string() }),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      404: z.object({ error: z.string() }),
    },
  },
});
