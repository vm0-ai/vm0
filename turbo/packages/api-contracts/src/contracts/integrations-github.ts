import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const deleteGithubInstallationResponseSchema = z.object({
  ok: z.literal(true),
});

export type DeleteGithubInstallationResponse = z.infer<
  typeof deleteGithubInstallationResponseSchema
>;

export const integrationsGithubContract = c.router({
  deleteInstallation: {
    method: "DELETE",
    path: "/api/integrations/github",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: deleteGithubInstallationResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Uninstall the authenticated user's GitHub App installation",
  },
});

export type IntegrationsGithubContract = typeof integrationsGithubContract;
