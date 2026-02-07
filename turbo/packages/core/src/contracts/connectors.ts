import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Secret field configuration for connector auth methods
 */
export interface ConnectorSecretConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

/**
 * Auth method configuration for connectors
 */
export interface ConnectorAuthMethodConfig {
  label: string;
  helpText?: string;
  secrets: Record<string, ConnectorSecretConfig>;
}

/**
 * OAuth configuration for connectors that support OAuth flow
 */
export interface ConnectorOAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Connector type configuration
 * Maps type to display info, auth methods, and environment mapping
 *
 * For connectors with `environmentMapping`, secrets are mapped to environment variables:
 * - `$secrets.X` - lookup secret X from the connector's secrets
 * - Other values are passed through as literals
 */
export const CONNECTOR_TYPES = {
  github: {
    label: "GitHub",
    helpText:
      "Connect your GitHub account to access repositories and GitHub features",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with GitHub to grant access.",
        secrets: {
          GITHUB_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    } as Record<string, ConnectorAuthMethodConfig>,
    defaultAuthMethod: "oauth",
    environmentMapping: {
      GH_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
      GITHUB_TOKEN: "$secrets.GITHUB_ACCESS_TOKEN",
    } as Record<string, string>,
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
    } as ConnectorOAuthConfig,
  },
} as const;

export type ConnectorType = keyof typeof CONNECTOR_TYPES;

export const connectorTypeSchema = z.enum(["github"]);

/**
 * Get auth methods for a connector type
 */
export function getConnectorAuthMethods(
  type: ConnectorType,
): Record<string, ConnectorAuthMethodConfig> {
  return CONNECTOR_TYPES[type].authMethods;
}

/**
 * Get default auth method for a connector type
 */
export function getConnectorDefaultAuthMethod(type: ConnectorType): string {
  return CONNECTOR_TYPES[type].defaultAuthMethod;
}

/**
 * Get secrets config for a specific auth method
 */
export function getConnectorSecretsForAuthMethod(
  type: ConnectorType,
  authMethod: string,
): Record<string, ConnectorSecretConfig> | undefined {
  const authMethods = getConnectorAuthMethods(type);
  return authMethods[authMethod]?.secrets;
}

/**
 * Get secret names for a specific auth method
 */
export function getConnectorSecretNames(
  type: ConnectorType,
  authMethod: string,
): string[] {
  const secrets = getConnectorSecretsForAuthMethod(type, authMethod);
  return secrets ? Object.keys(secrets) : [];
}

/**
 * Get environment mapping for a connector type
 */
export function getConnectorEnvironmentMapping(
  type: ConnectorType,
): Record<string, string> {
  return CONNECTOR_TYPES[type].environmentMapping;
}

/**
 * Get OAuth configuration for a connector type
 */
export function getConnectorOAuthConfig(
  type: ConnectorType,
): ConnectorOAuthConfig | undefined {
  const config = CONNECTOR_TYPES[type];
  return "oauth" in config ? config.oauth : undefined;
}

/**
 * Connector response schema
 */
export const connectorResponseSchema = z.object({
  id: z.string().uuid(),
  type: connectorTypeSchema,
  authMethod: z.string(),
  externalId: z.string().nullable(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  oauthScopes: z.array(z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConnectorResponse = z.infer<typeof connectorResponseSchema>;

/**
 * List connectors response
 */
export const connectorListResponseSchema = z.object({
  connectors: z.array(connectorResponseSchema),
});

export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

/**
 * Connectors main contract for /api/connectors
 */
export const connectorsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/connectors",
    headers: authHeadersSchema,
    responses: {
      200: connectorListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all connectors for the authenticated user",
  },
});

export type ConnectorsMainContract = typeof connectorsMainContract;

/**
 * Connector by type contract for /api/connectors/[type]
 */
export const connectorsByTypeContract = c.router({
  get: {
    method: "GET",
    path: "/api/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get connector status by type",
  },
  delete: {
    method: "DELETE",
    path: "/api/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disconnect a connector",
  },
});

export type ConnectorsByTypeContract = typeof connectorsByTypeContract;

/**
 * Connector session status enum
 */
export const connectorSessionStatusSchema = z.enum([
  "pending",
  "complete",
  "expired",
  "error",
]);

export type ConnectorSessionStatus = z.infer<
  typeof connectorSessionStatusSchema
>;

/**
 * Connector session response schema
 */
export const connectorSessionResponseSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  type: connectorTypeSchema,
  status: connectorSessionStatusSchema,
  verificationUrl: z.string(),
  expiresIn: z.number(),
  interval: z.number(),
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionResponse = z.infer<
  typeof connectorSessionResponseSchema
>;

/**
 * Connector session status response (for polling)
 */
export const connectorSessionStatusResponseSchema = z.object({
  status: connectorSessionStatusSchema,
  errorMessage: z.string().nullable().optional(),
});

export type ConnectorSessionStatusResponse = z.infer<
  typeof connectorSessionStatusResponseSchema
>;

/**
 * Connector sessions contract for /api/connectors/[type]/sessions
 * Used for CLI device flow - initiate OAuth from CLI
 */
export const connectorSessionsContract = c.router({
  /**
   * POST /api/connectors/:type/sessions
   * Create a new connector session for CLI device flow
   */
  create: {
    method: "POST",
    path: "/api/connectors/:type/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
    }),
    body: z.object({}).optional(),
    responses: {
      200: connectorSessionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector session for CLI device flow",
  },
});

export type ConnectorSessionsContract = typeof connectorSessionsContract;

/**
 * Connector session by ID contract for /api/connectors/[type]/sessions/[id]
 * Used for CLI polling to check session status
 */
export const connectorSessionByIdContract = c.router({
  /**
   * GET /api/connectors/:type/sessions/:sessionId
   * Get connector session status (for CLI polling)
   */
  get: {
    method: "GET",
    path: "/api/connectors/:type/sessions/:sessionId",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
      sessionId: z.string().uuid(),
    }),
    responses: {
      200: connectorSessionStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get connector session status",
  },
});

export type ConnectorSessionByIdContract = typeof connectorSessionByIdContract;
