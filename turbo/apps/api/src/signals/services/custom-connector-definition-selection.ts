import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

export function customConnectorDefinitionSelection() {
  return {
    id: orgCustomConnectors.id,
    orgId: orgCustomConnectors.orgId,
    slug: orgCustomConnectors.slug,
    displayName: orgCustomConnectors.displayName,
    prefixes: orgCustomConnectors.prefixes,
    headerName: orgCustomConnectors.headerName,
    headerTemplate: orgCustomConnectors.headerTemplate,
    prefixTemplates: orgCustomConnectors.prefixTemplates,
    fields: orgCustomConnectors.fields,
    headerInjections: orgCustomConnectors.headerInjections,
    queryInjections: orgCustomConnectors.queryInjections,
    authMode: orgCustomConnectors.authMode,
    enabled: orgCustomConnectors.enabled,
    permissionBundleRef: orgCustomConnectors.permissionBundleRef,
    mcpEndpoint: orgCustomConnectors.mcpEndpoint,
    mcpTransport: orgCustomConnectors.mcpTransport,
    mcpResource: orgCustomConnectors.mcpResource,
    skillMarkdown: orgCustomConnectors.skillMarkdown,
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
