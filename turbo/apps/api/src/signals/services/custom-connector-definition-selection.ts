import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";

export function customConnectorDefinitionSelection() {
  return {
    id: orgCustomConnectors.id,
    orgId: orgCustomConnectors.orgId,
    slug: orgCustomConnectors.slug,
    displayName: orgCustomConnectors.displayName,
    prefixTemplates: orgCustomConnectors.prefixTemplates,
    fields: orgCustomConnectors.fields,
    headerInjections: orgCustomConnectors.headerInjections,
    queryInjections: orgCustomConnectors.queryInjections,
    authMode: orgCustomConnectors.authMode,
    oauthSetup: orgCustomConnectors.oauthSetup,
    enabled: orgCustomConnectors.enabled,
    permissionBundleRef: orgCustomConnectors.permissionBundleRef,
    mcpEndpoint: orgCustomConnectors.mcpEndpoint,
    mcpTransport: orgCustomConnectors.mcpTransport,
    skillMarkdown: orgCustomConnectors.skillMarkdown,
    skillStorageVersionId: orgCustomConnectors.skillStorageVersionId,
    storageVersion: orgCustomConnectors.storageVersion,
    createdBy: orgCustomConnectors.createdBy,
    createdAt: orgCustomConnectors.createdAt,
    updatedAt: orgCustomConnectors.updatedAt,
  } as const;
}

export type CustomConnectorDefinitionRow = Pick<
  typeof orgCustomConnectors.$inferSelect,
  keyof ReturnType<typeof customConnectorDefinitionSelection>
>;
