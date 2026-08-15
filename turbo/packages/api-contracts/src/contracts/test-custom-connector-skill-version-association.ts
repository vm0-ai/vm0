import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testCustomConnectorSkillVersionAssociationContract = c.router({
  associate: {
    method: "POST",
    path: "/api/test/custom-connector-skill-version-association",
    body: z.object({
      connectorId: z.string().uuid(),
      skillStorageVersionId: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      404: apiErrorSchema,
    },
    summary: "Associate a Custom connector with an existing skill version",
  },
});
