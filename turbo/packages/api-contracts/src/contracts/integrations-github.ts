import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const githubInstallationEnvironmentSchema = z.object({
  requiredSecrets: z.array(z.string()),
  requiredVars: z.array(z.string()),
  missingSecrets: z.array(z.string()),
  missingVars: z.array(z.string()),
});

export const githubInstallationResponseSchema = z.object({
  installation: z.object({
    id: z.string(),
    installationId: z.string().nullable(),
    status: z.string(),
    targetName: z.string().nullable(),
    targetType: z.string().nullable(),
    isAdmin: z.boolean(),
  }),
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  environment: githubInstallationEnvironmentSchema,
});

export type GithubInstallationResponse = z.infer<
  typeof githubInstallationResponseSchema
>;

export const githubInstallationNotFoundResponseSchema = apiErrorSchema.extend({
  installUrl: z.string().nullable(),
});

export type GithubInstallationNotFoundResponse = z.infer<
  typeof githubInstallationNotFoundResponseSchema
>;

export const deleteGithubInstallationResponseSchema = z.object({
  ok: z.literal(true),
});

export type DeleteGithubInstallationResponse = z.infer<
  typeof deleteGithubInstallationResponseSchema
>;

export const integrationsGithubContract = c.router({
  getInstallation: {
    method: "GET",
    path: "/api/integrations/github",
    headers: authHeadersSchema,
    responses: {
      200: githubInstallationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: githubInstallationNotFoundResponseSchema,
      500: apiErrorSchema,
    },
    summary: "Get the authenticated user's GitHub App installation",
  },

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
