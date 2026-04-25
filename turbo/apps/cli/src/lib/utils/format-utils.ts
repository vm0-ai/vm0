import chalk from "chalk";
import type { FirewallPolicyValue } from "@vm0/api-contracts/contracts/firewalls";

export function policyIcon(policy: FirewallPolicyValue): string {
  if (policy === "allow") return chalk.green("✓");
  if (policy === "ask") return chalk.yellow("?");
  return chalk.dim("✗");
}
