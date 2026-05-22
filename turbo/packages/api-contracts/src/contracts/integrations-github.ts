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

export const githubLabelTriggerModeSchema = z.enum(["created_by_me", "anyone"]);

export type GithubLabelTriggerMode = z.infer<
  typeof githubLabelTriggerModeSchema
>;

export const githubLabelListenerSchema = z.object({
  id: z.string(),
  labelName: z.string(),
  triggerMode: githubLabelTriggerModeSchema,
  prompt: z.string(),
  enabled: z.boolean(),
  canManage: z.boolean(),
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type GithubLabelListener = z.infer<typeof githubLabelListenerSchema>;

export const githubInstallationResponseSchema = z.object({
  installation: z.object({
    id: z.string(),
    installationId: z.string().nullable(),
    status: z.string(),
    targetName: z.string().nullable(),
    targetType: z.string().nullable(),
    isAdmin: z.boolean(),
  }),
  isConnected: z.boolean(),
  connectedGithubUserId: z.string().nullable(),
  connectedGithubUsername: z.string().nullable(),
  installUrl: z.string().nullable(),
  connectUrl: z.string(),
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  environment: githubInstallationEnvironmentSchema,
  labelListeners: z.array(githubLabelListenerSchema),
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

export const patchGithubInstallationBodySchema = z.object({
  agentName: z.string().min(1),
});

export type PatchGithubInstallationBody = z.infer<
  typeof patchGithubInstallationBodySchema
>;

export const updateGithubInstallationResponseSchema = z.object({
  ok: z.literal(true),
});

export type UpdateGithubInstallationResponse = z.infer<
  typeof updateGithubInstallationResponseSchema
>;

export const githubIntegrationActionResponseSchema = z.object({
  ok: z.literal(true),
});

export type GithubIntegrationActionResponse = z.infer<
  typeof githubIntegrationActionResponseSchema
>;

export const createGithubLabelListenerBodySchema = z.object({
  labelName: z.string().min(1).max(255),
  triggerMode: githubLabelTriggerModeSchema,
  prompt: z.string().min(1),
  agentId: z.string().uuid(),
  enabled: z.boolean().optional(),
});

export type CreateGithubLabelListenerBody = z.infer<
  typeof createGithubLabelListenerBodySchema
>;

export const updateGithubLabelListenerBodySchema = z.object({
  labelName: z.string().min(1).max(255).optional(),
  triggerMode: githubLabelTriggerModeSchema.optional(),
  prompt: z.string().min(1).optional(),
  agentId: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateGithubLabelListenerBody = z.infer<
  typeof updateGithubLabelListenerBodySchema
>;

export const createGithubLabelListenerResponseSchema = z.object({
  listener: githubLabelListenerSchema,
});

export type CreateGithubLabelListenerResponse = z.infer<
  typeof createGithubLabelListenerResponseSchema
>;

export const updateGithubLabelListenerResponseSchema = z.object({
  listener: githubLabelListenerSchema,
});

export type UpdateGithubLabelListenerResponse = z.infer<
  typeof updateGithubLabelListenerResponseSchema
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

  connectUser: {
    method: "POST",
    path: "/api/integrations/github/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: githubIntegrationActionResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Link the authenticated VM0 user to the org GitHub App installation",
  },

  disconnectUser: {
    method: "DELETE",
    path: "/api/integrations/github/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: githubIntegrationActionResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Disconnect the authenticated VM0 user from the org GitHub App installation",
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

  updateInstallation: {
    method: "PATCH",
    path: "/api/integrations/github",
    headers: authHeadersSchema,
    body: patchGithubInstallationBodySchema,
    responses: {
      200: updateGithubInstallationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update the authenticated user's GitHub App installation",
  },

  createLabelListener: {
    method: "POST",
    path: "/api/integrations/github/label-listeners",
    headers: authHeadersSchema,
    body: createGithubLabelListenerBodySchema,
    responses: {
      201: createGithubLabelListenerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a GitHub label listener",
  },

  updateLabelListener: {
    method: "PATCH",
    path: "/api/integrations/github/label-listeners/:listenerId",
    pathParams: z.object({ listenerId: z.string().uuid() }),
    headers: authHeadersSchema,
    body: updateGithubLabelListenerBodySchema,
    responses: {
      200: updateGithubLabelListenerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update a GitHub label listener",
  },

  deleteLabelListener: {
    method: "DELETE",
    path: "/api/integrations/github/label-listeners/:listenerId",
    pathParams: z.object({ listenerId: z.string().uuid() }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: githubIntegrationActionResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a GitHub label listener",
  },
});

export type IntegrationsGithubContract = typeof integrationsGithubContract;
