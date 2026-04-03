import { Command } from "commander";
import chalk from "chalk";
import {
  getZeroAgent,
  getZeroAgentInstructions,
  getZeroAgentUserConnectors,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import {
  isFirewallConnectorType,
  getConnectorFirewall,
  resolveFirewallPolicies,
  type FirewallPolicyValue,
} from "@vm0/core";

interface ConnectorPermissionInfo {
  type: string;
  hasFirewall: boolean;
  permissions: Array<{ name: string; description?: string }>;
  policies: Record<string, FirewallPolicyValue> | null;
  allowed: number;
  total: number;
}

function getConnectorPermissionInfo(
  type: string,
  resolvedPolicies: Record<string, Record<string, FirewallPolicyValue>> | null,
): ConnectorPermissionInfo {
  if (!isFirewallConnectorType(type)) {
    return {
      type,
      hasFirewall: false,
      permissions: [],
      policies: null,
      allowed: 0,
      total: 0,
    };
  }

  const policies = resolvedPolicies?.[type] ?? null;
  const config = getConnectorFirewall(type);
  const permissions = config.apis.flatMap((a) => {
    return a.permissions ?? [];
  });
  const total = permissions.length;
  const allowed = policies
    ? permissions.filter((p) => {
        return policies[p.name] === "allow";
      }).length
    : 0;

  return { type, hasFirewall: true, permissions, policies, allowed, total };
}

function formatConnectorSummary(info: ConnectorPermissionInfo): string {
  if (!info.hasFirewall) return info.type;
  if (!info.policies) return `${info.type} (full access)`;
  return `${info.type} (${info.allowed}/${info.total} allowed)`;
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
        const agent = await getZeroAgent(agentId);

        console.log(chalk.bold(agent.agentId));
        if (agent.displayName) console.log(chalk.dim(agent.displayName));
        console.log();
        console.log(`Agent ID:     ${agent.agentId}`);
        const connectors = await getZeroAgentUserConnectors(agentId);

        const resolvedPolicies = resolveFirewallPolicies(
          agent.firewallPolicies,
          connectors,
        );

        const connectorInfos = connectors.map((type) => {
          return getConnectorPermissionInfo(type, resolvedPolicies);
        });

        if (connectorInfos.length > 0) {
          const summaries = connectorInfos.map(formatConnectorSummary);
          console.log(`Connectors:   ${summaries.join(", ")}`);
        }

        if (agent.customSkills?.length > 0) {
          console.log(`Skills:       ${agent.customSkills.join(", ")}`);
        }
        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);

        if (options.permissions && connectorInfos.length > 0) {
          console.log();
          for (const info of connectorInfos) {
            if (!info.hasFirewall) {
              console.log(chalk.dim(`── ${info.type} ──`));
              console.log("  No firewall configured.");
              continue;
            }

            if (!info.policies) {
              console.log(chalk.dim(`── ${info.type} (full access) ──`));
              console.log(
                "  No permission rules configured — all API calls allowed.",
              );
              continue;
            }

            console.log(
              chalk.dim(
                `── ${info.type} (${info.allowed}/${info.total} allowed) ──`,
              ),
            );

            const nameWidth = Math.max(
              ...info.permissions.map((p) => {
                return p.name.length;
              }),
            );

            for (const perm of info.permissions) {
              const policy = info.policies[perm.name] ?? "deny";
              const icon =
                policy === "allow"
                  ? chalk.green("✓")
                  : policy === "ask"
                    ? chalk.yellow("?")
                    : chalk.dim("✗");
              const desc = perm.description ?? "";
              console.log(`  ${icon} ${perm.name.padEnd(nameWidth)}  ${desc}`);
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
