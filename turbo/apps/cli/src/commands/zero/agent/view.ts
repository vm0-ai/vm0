import { Command } from "commander";
import chalk from "chalk";
import {
  getZeroAgent,
  getZeroAgentInstructions,
  getZeroAgentUserConnectors,
  listZeroUserPermissionGrants,
  listZeroConnectors,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { permissionGrantsToFirewallPolicies } from "@vm0/connectors/firewall-metadata";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { policyIcon } from "../../../lib/utils/format-utils";
import { formatAvatar } from "./avatar";
import {
  loadConnectorPermissionInfos,
  type ConnectorPermissionInfo,
} from "../shared/firewall-permissions";

function printDetailedPermissions(info: ConnectorPermissionInfo): void {
  if (!info.policies) {
    const icon = policyIcon(info.unknownPolicy);
    console.log(`    ${icon} unknown endpoints`);
    return;
  }

  const nameWidth = Math.max(
    "unknown endpoints".length,
    ...info.permissions.map((p) => {
      return p.name.length;
    }),
  );

  for (const perm of info.permissions) {
    const policy = info.policies[perm.name] ?? "deny";
    const desc = perm.description ?? "";
    console.log(
      `    ${policyIcon(policy)} ${perm.name.padEnd(nameWidth)}  ${desc}`,
    );
  }

  const unknownIcon = policyIcon(info.unknownPolicy);
  console.log(
    `    ${unknownIcon} ${"unknown endpoints".padEnd(nameWidth)}  Endpoints not matching any rule`,
  );
}

function formatConnectorIdentity(
  connector: ConnectorResponse | undefined,
): string {
  if (!connector) return "";
  if (connector.externalUsername) return `@${connector.externalUsername}`;
  if (connector.externalEmail) return connector.externalEmail;
  return "";
}

function formatConnectorSummary(
  info: ConnectorPermissionInfo,
  identity?: ConnectorResponse,
): string {
  const id = formatConnectorIdentity(identity);
  const idStr = id ? ` ${id}` : "";
  if (!info.hasPermissions) return `${info.type}${idStr}`;
  if (!info.policies) return `${info.type}${idStr} (full access)`;
  return `${info.type}${idStr} (${info.allowed}/${info.total} allowed)`;
}

function formatDetailIdentity(
  connector: ConnectorResponse | undefined,
): string {
  if (!connector) return "";
  let identity = "";
  if (connector.externalUsername && connector.externalEmail) {
    identity = `@${connector.externalUsername} (${connector.externalEmail})`;
  } else if (connector.externalUsername) {
    identity = `@${connector.externalUsername}`;
  } else if (connector.externalEmail) {
    identity = connector.externalEmail;
  }
  if (!identity) return "";
  if (connector.connectionStatus === "reconnect-required") {
    identity += ` ${chalk.yellow("(needs reconnect)")}`;
  }
  return identity;
}

export const viewCommand = new Command()
  .name("view")
  .description("View a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("--instructions", "Also show instructions content")
  .option("--permissions", "Show full permission details for each connector")
  .addHelpText(
    "after",
    `
Examples:
  View basic info:         zero agent view <agent-id>
  Include instructions:    zero agent view <agent-id> --instructions
  Show permissions:        zero agent view <agent-id> --permissions
  View yourself:           zero agent view $ZERO_AGENT_ID --instructions`,
  )
  .action(
    withErrorHandler(
      async (
        agentId: string,
        options: { instructions?: boolean; permissions?: boolean },
      ) => {
        const [agent, connectorTypes, connectorIdentities] = await Promise.all([
          getZeroAgent(agentId),
          getZeroAgentUserConnectors(agentId),
          listZeroConnectors().catch(() => {
            return { connectors: [] as ConnectorResponse[] };
          }),
        ]);

        const identityMap = new Map<string, ConnectorResponse>(
          connectorIdentities.connectors.map((c) => {
            return [c.type, c];
          }),
        );

        console.log(chalk.bold(agent.agentId));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Agent ID:     ${agent.agentId}`);

        const storedPolicies = options.permissions
          ? permissionGrantsToFirewallPolicies(
              await listZeroUserPermissionGrants(agent.agentId),
            )
          : null;
        const connectorInfos = await loadConnectorPermissionInfos({
          displayTypes: connectorTypes,
          defaultPolicyTypes: connectorTypes,
          storedPolicies,
        });

        if (connectorInfos.length > 0) {
          const summaries = connectorInfos.map((info) => {
            return formatConnectorSummary(info, identityMap.get(info.type));
          });
          console.log(`Connectors:   ${summaries.join(", ")}`);
        }

        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);
        const avatar = formatAvatar(agent.avatarUrl);
        if (avatar) console.log(`Avatar:       ${avatar}`);

        if (options.permissions && connectorInfos.length > 0) {
          console.log();
          console.log(chalk.bold("Connectors:"));
          for (const info of connectorInfos) {
            const identity = formatDetailIdentity(identityMap.get(info.type));
            console.log(`  ${info.type.padEnd(14)}${identity}`);
            if (info.hasPermissions) {
              printDetailedPermissions(info);
            }
          }
        }

        if (options.instructions) {
          console.log();
          const result = await getZeroAgentInstructions(agentId);
          if (result.content) {
            console.log(chalk.dim("── Instructions ──"));
            console.log(result.content);
          } else {
            console.log(chalk.dim("No instructions set"));
          }
        }
      },
    ),
  );
