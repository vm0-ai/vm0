import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testDesktopUpdateManifestStateContract = c.router({
  reset: {
    method: "POST",
    path: "/api/test/desktop-update-manifest-state/reset",
    body: z.object({}),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      404: z.string(),
    },
    summary: "Reset desktop update manifest test state",
  },
});
