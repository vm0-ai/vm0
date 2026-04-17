import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  isFeatureEnabled,
  searchConnectors,
  type ConnectorType,
} from "@vm0/core";
import { getActiveOrg } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";
import { resolveAgentContext } from "./agent-context";

const DEFAULT_LIMIT = 5;
const EXACT_MATCH_THRESHOLD = 80;
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

function padEndAnsi(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return s + " ".repeat(Math.max(0, width - visible));
}

function parseLimit(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--limit must be a positive integer, got "${raw}".`);
  }
  return n;
}

export const searchCommand = new Command()
  .name("search")
  .description("Search connectors by type, label, env var, secret, or tag")
  .argument("<keyword>", "Search keyword (case-insensitive)")
  .option("--agent <id>", "Show per-agent authorization column")
  .option(
    "--limit <n>",
    `Maximum number of results to display (default ${DEFAULT_LIMIT})`,
    parseLimit,
    DEFAULT_LIMIT,
  )
  .action(
    withErrorHandler(
      async (keyword: string, options: { agent?: string; limit: number }) => {
        const trimmed = keyword.trim();
        if (!trimmed) {
          throw new Error("Keyword cannot be empty.");
        }

        const [orgId, agentCtx] = await Promise.all([
          getActiveOrg(),
          resolveAgentContext(options.agent),
        ]);

        const isTypeAvailable = (type: ConnectorType): boolean => {
          const config = CONNECTOR_TYPES[type];
          const flag = config.featureFlag;
          const hasApiToken = "api-token" in config.authMethods;
          return !flag || isFeatureEnabled(flag, { orgId }) || hasApiToken;
        };

        const { results, total } = searchConnectors(
          trimmed,
          options.limit,
          isTypeAvailable,
        );

        if (results.length === 0) {
          console.log("No matches found.");
          return;
        }

        const topScore = results[0]!.score;
        if (topScore < EXACT_MATCH_THRESHOLD) {
          console.log("No exact match. Showing closest:");
        }
        if (total > options.limit) {
          console.log(`Too many results (top ${options.limit} of ${total}):`);
        }

        const typeHeader = "TYPE";
        const labelHeader = "LABEL";
        const typeWidth = Math.max(
          typeHeader.length,
          ...results.map((r) => {
            return r.type.length;
          }),
        );
        const labelWidth = Math.max(
          labelHeader.length,
          ...results.map((r) => {
            return CONNECTOR_TYPES[r.type].label.length;
          }),
        );

        const headerParts = [
          typeHeader.padEnd(typeWidth),
          labelHeader.padEnd(labelWidth),
        ];
        if (agentCtx) {
          headerParts.push(`AUTHORIZED FOR ${agentCtx.displayName}`);
        }
        console.log(chalk.dim(headerParts.join("  ")));

        for (const result of results) {
          const config = CONNECTOR_TYPES[result.type];
          const parts = [
            result.type.padEnd(typeWidth),
            padEndAnsi(config.label, labelWidth),
          ];
          if (agentCtx) {
            parts.push(
              agentCtx.authorizedTypes.has(result.type)
                ? chalk.green("✓")
                : chalk.dim("-"),
            );
          }
          console.log(parts.join("  "));
        }
      },
    ),
  );
