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
} from "@vm0/core";

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

        if (connectors.length > 0) {
          const summaries = connectors.map((type) => {
            if (!isFirewallConnectorType(type)) return type;
            const policies = resolvedPolicies?.[type];
            if (!policies) return `${type} (full access)`;
            const config = getConnectorFirewall(type);
            const allPerms = config.apis.flatMap((a) => {
              return a.permissions ?? [];
            });
            const total = allPerms.length;
            const allowed = allPerms.filter((p) => {
              return policies[p.name] === "allow";
            }).length;
            return `${type} (${allowed}/${total} allowed)`;
          });
          console.log(`Connectors:   ${summaries.join(", ")}`);
        }

        if (agent.customSkills?.length > 0) {
          console.log(`Skills:       ${agent.customSkills.join(", ")}`);
        }
        if (agent.description)
          console.log(`Description:  ${agent.description}`);
        if (agent.sound) console.log(`Sound:        ${agent.sound}`);

        if (options.permissions && connectors.length > 0) {
          console.log();
          for (const type of connectors) {
            if (!isFirewallConnectorType(type)) {
              console.log(chalk.dim(`── ${type} ──`));
              console.log("  No firewall configured.");
              continue;
            }

            const policies = resolvedPolicies?.[type];
            const config = getConnectorFirewall(type);
            const allPerms = config.apis.flatMap((a) => {
              return a.permissions ?? [];
            });

            if (!policies) {
              console.log(chalk.dim(`── ${type} (full access) ──`));
              console.log(
                "  No permission rules configured — all API calls allowed.",
              );
              continue;
            }

            const total = allPerms.length;
            const allowed = allPerms.filter((p) => {
              return policies[p.name] === "allow";
            }).length;
            console.log(
              chalk.dim(`── ${type} (${allowed}/${total} allowed) ──`),
            );

            const nameWidth = Math.max(
              ...allPerms.map((p) => {
                return p.name.length;
              }),
            );

            for (const perm of allPerms) {
              const policy = policies[perm.name] ?? "deny";
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
