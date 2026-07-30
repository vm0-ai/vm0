import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { agentRunCustomConnectorAuthRefs } from "../schema/agent-run-custom-connector-auth-ref";
import { connectorOauthStates } from "../schema/connector-oauth-state";
import { connectors } from "../schema/connector";
import { orgCustomConnectorOauthConfigs } from "../schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "../schema/org-custom-connector";
import { secrets } from "../schema/secret";
import { userCustomConnectors } from "../schema/user-custom-connector";

function names(items: readonly { readonly name?: string }[]): string[] {
  return items.flatMap((item) => {
    return item.name ? [item.name] : [];
  });
}

describe("custom connector auth storage schema", () => {
  it("keeps one organization-owned connector root and one OAuth config", () => {
    const connectorConfig = getTableConfig(orgCustomConnectors);
    const oauthConfig = getTableConfig(orgCustomConnectorOauthConfigs);

    expect(orgCustomConnectors.authMode.notNull).toBe(true);
    expect(orgCustomConnectors.enabled.notNull).toBe(true);
    expect(orgCustomConnectors.revision.notNull).toBe(true);
    expect(names(connectorConfig.uniqueConstraints)).toContain(
      "idx_org_custom_connectors_id_org",
    );
    expect(names(connectorConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_org_custom_connectors_slug",
        "chk_org_custom_connectors_auth_mode",
        "chk_org_custom_connectors_mcp",
        "chk_org_custom_connectors_revision_positive",
        "chk_org_custom_connectors_skill_size",
      ]),
    );

    expect(orgCustomConnectorOauthConfigs.connectorId.primary).toBe(true);
    expect(oauthConfig.foreignKeys).toHaveLength(1);
    expect(oauthConfig.foreignKeys[0]?.onDelete).toBe("cascade");
    expect(names(oauthConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_org_custom_connector_oauth_configs_provider_adapter",
        "chk_org_custom_connector_oauth_configs_pkce_method",
        "chk_org_custom_connector_oauth_configs_token_auth_method",
      ]),
    );
  });

  it("separates built-in and custom connection identities", () => {
    const connectorConfig = getTableConfig(connectors);
    const stateConfig = getTableConfig(connectorOauthStates);

    expect(connectors.connectorSlug.notNull).toBe(false);
    expect(connectors.customConnectorId.notNull).toBe(false);
    expect(names(connectorConfig.checks)).toContain("chk_connectors_identity");
    expect(
      connectorConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "idx_connectors_org_user_slug",
        "idx_connectors_org_user_custom_connector",
      ]),
    );
    expect(names(connectorConfig.uniqueConstraints)).toContain(
      "idx_connectors_id_org_user",
    );
    expect(
      connectorConfig.indexes.find((index) => {
        return index.config.name === "idx_connectors_org_user_slug";
      })?.config.where,
    ).toBeDefined();

    expect(connectorOauthStates.connectorSlug.notNull).toBe(false);
    expect(names(stateConfig.checks)).toEqual(
      expect.arrayContaining([
        "chk_connector_oauth_states_identity",
        "chk_connector_oauth_states_custom_revision",
      ]),
    );
  });

  it("owns OAuth tokens by connection and versions agent grants", () => {
    const secretConfig = getTableConfig(secrets);
    const grantConfig = getTableConfig(userCustomConnectors);

    expect(
      secretConfig.indexes.map((index) => {
        return index.config.name;
      }),
    ).toEqual(
      expect.arrayContaining([
        "idx_secrets_connector_name",
        "idx_secrets_org_user_name_type",
      ]),
    );
    expect(secretConfig.foreignKeys[0]?.onDelete).toBe("cascade");

    expect(userCustomConnectors.connectorRevision.notNull).toBe(true);
    expect(userCustomConnectors.permissionNames.notNull).toBe(true);
    expect(userCustomConnectors.allowAllMcpTools.notNull).toBe(true);
    expect(userCustomConnectors.mcpToolNames.notNull).toBe(true);
    expect(names(grantConfig.checks)).toContain(
      "chk_user_custom_connectors_mcp_grant",
    );

    expect(agentRunCustomConnectorAuthRefs.connectorRevision.notNull).toBe(
      true,
    );
  });
});
