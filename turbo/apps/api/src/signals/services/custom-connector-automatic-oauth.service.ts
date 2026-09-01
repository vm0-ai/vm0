import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";

import type { Db } from "../external/db";

const oauthHttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    return new URL(value).protocol === "https:";
  });

const tokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

const automaticOAuthBindingBaseSchema = z.object({
  connectorAccountId: z.string().uuid(),
  customConnectorId: z.string().uuid(),
  issuer: oauthHttpsUrlSchema,
  resource: oauthHttpsUrlSchema,
  resourceMetadataUrl: oauthHttpsUrlSchema.nullable(),
  tokenEndpoint: oauthHttpsUrlSchema,
  clientId: z.string().min(1),
  tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
});

const dcrRegistrationSchema = z
  .object({
    id: z.string().uuid(),
    customConnectorId: z.string().uuid(),
    issuer: oauthHttpsUrlSchema,
    clientId: z.string().min(1),
    tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
    hasClientSecret: z.boolean(),
    registeredScopes: z.array(z.string().min(1)),
    redirectUri: oauthHttpsUrlSchema,
    issuedAt: z.date(),
    expiresAt: z.date().nullable(),
  })
  .refine((registration) => {
    return registration.tokenEndpointAuthMethod === "none"
      ? !registration.hasClientSecret
      : registration.hasClientSecret;
  })
  .refine((registration) => {
    return (
      registration.expiresAt === null ||
      registration.expiresAt > registration.issuedAt
    );
  });

const customConnectorAutomaticOAuthBindingSchema = z.union([
  automaticOAuthBindingBaseSchema.extend({
    registrationMethod: z.literal("cimd"),
    dcrRegistration: z.null(),
    tokenEndpointAuthMethod: z.literal("none"),
  }),
  automaticOAuthBindingBaseSchema
    .extend({
      registrationMethod: z.literal("dcr"),
      dcrRegistration: dcrRegistrationSchema,
    })
    .refine((binding) => {
      return (
        binding.customConnectorId ===
          binding.dcrRegistration.customConnectorId &&
        binding.issuer === binding.dcrRegistration.issuer &&
        binding.clientId === binding.dcrRegistration.clientId &&
        binding.tokenEndpointAuthMethod ===
          binding.dcrRegistration.tokenEndpointAuthMethod
      );
    }),
]);

type CustomConnectorAutomaticOAuthBinding = z.infer<
  typeof customConnectorAutomaticOAuthBindingSchema
>;

const automaticOAuthBindingPersistenceSchema = z
  .intersection(
    z.object({
      accountAuthMethod: z.literal("oauth"),
      accountStorageVersion: z.number().int().positive(),
      connectorAuthMode: z.literal("oauth"),
      connectorOAuthSetup: z.literal("automatic"),
      connectorStorageVersion: z.number().int().positive(),
    }),
    customConnectorAutomaticOAuthBindingSchema,
  )
  .refine((row) => {
    return row.accountStorageVersion === row.connectorStorageVersion;
  })
  .transform((row) => {
    return customConnectorAutomaticOAuthBindingSchema.parse(row);
  });

export async function readCustomConnectorAutomaticOAuthBinding(
  db: Db,
  connectorAccountId: string,
): Promise<CustomConnectorAutomaticOAuthBinding | null> {
  const [row] = await db
    .select({
      accountAuthMethod: connectors.authMethod,
      accountStorageVersion: connectors.storageVersion,
      connectorAuthMode: orgCustomConnectors.authMode,
      connectorOAuthSetup: orgCustomConnectors.oauthSetup,
      connectorStorageVersion: orgCustomConnectors.storageVersion,
      connectorAccountId:
        customConnectorAccountOauthBindings.connectorAccountId,
      customConnectorId: customConnectorAccountOauthBindings.customConnectorId,
      issuer: customConnectorAccountOauthBindings.issuer,
      resource: customConnectorAccountOauthBindings.resource,
      resourceMetadataUrl:
        customConnectorAccountOauthBindings.resourceMetadataUrl,
      tokenEndpoint: customConnectorAccountOauthBindings.tokenEndpoint,
      clientId: customConnectorAccountOauthBindings.clientId,
      tokenEndpointAuthMethod:
        customConnectorAccountOauthBindings.tokenEndpointAuthMethod,
      registrationMethod:
        customConnectorAccountOauthBindings.registrationMethod,
      dcrRegistration: {
        id: orgCustomConnectorDcrRegistrations.id,
        customConnectorId: orgCustomConnectorDcrRegistrations.customConnectorId,
        issuer: orgCustomConnectorDcrRegistrations.issuer,
        clientId: orgCustomConnectorDcrRegistrations.clientId,
        tokenEndpointAuthMethod:
          orgCustomConnectorDcrRegistrations.tokenEndpointAuthMethod,
        hasClientSecret: isNotNull(
          orgCustomConnectorDcrRegistrations.encryptedClientSecret,
        ),
        registeredScopes: orgCustomConnectorDcrRegistrations.registeredScopes,
        redirectUri: orgCustomConnectorDcrRegistrations.redirectUri,
        issuedAt: orgCustomConnectorDcrRegistrations.issuedAt,
        expiresAt: orgCustomConnectorDcrRegistrations.expiresAt,
      },
    })
    .from(customConnectorAccountOauthBindings)
    .innerJoin(
      connectors,
      and(
        eq(
          connectors.id,
          customConnectorAccountOauthBindings.connectorAccountId,
        ),
        eq(
          connectors.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(
          orgCustomConnectors.id,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorDcrRegistrations,
      and(
        eq(
          orgCustomConnectorDcrRegistrations.id,
          customConnectorAccountOauthBindings.dcrRegistrationId,
        ),
        eq(
          orgCustomConnectorDcrRegistrations.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .where(
      eq(
        customConnectorAccountOauthBindings.connectorAccountId,
        connectorAccountId,
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const parsed = automaticOAuthBindingPersistenceSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}
