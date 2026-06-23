import { Command } from "commander";
import chalk from "chalk";
import type { CreateTriggerRequest } from "@vm0/api-contracts/contracts/automations";
import { createAutomation, resolveCompose } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { requireTimezoneForLocalAtTime } from "./at-time-input";
import { parseDurationSeconds } from "./duration";
import { formatTriggerConfig } from "./trigger-display";

interface CreateOptions {
  name: string;
  agent: string;
  prompt: string;
  description?: string;
  cron?: string;
  once?: string;
  loop?: string;
  timezone?: string;
}

/**
 * Build the automation schedule trigger from exactly one inline flag
 * (--cron / --once / --loop, with optional --timezone).
 */
function buildInlineTrigger(options: CreateOptions): CreateTriggerRequest {
  const sugarCount = [options.cron, options.once, options.loop].filter(
    (value) => {
      return value !== undefined;
    },
  ).length;

  if (sugarCount !== 1) {
    throw new Error("Use exactly one of --cron, --once, --loop");
  }

  if (options.timezone && !options.cron && !options.once) {
    throw new Error("--timezone requires --cron or --once");
  }

  if (options.cron) {
    return {
      kind: "cron",
      cronExpression: options.cron,
      timezone: options.timezone,
    };
  }
  if (options.once) {
    requireTimezoneForLocalAtTime(options.once, options.timezone, "--once");
    return { kind: "once", atTime: options.once, timezone: options.timezone };
  }
  if (options.loop) {
    return {
      kind: "loop",
      intervalSeconds: parseDurationSeconds(options.loop),
    };
  }
  throw new Error("Use exactly one of --cron, --once, --loop");
}

export const createCommand = new Command()
  .name("create")
  .description("Create an automation with a schedule trigger")
  .requiredOption("-n, --name <name>", "Automation name")
  .requiredOption("--agent <id>", "Agent ID or name to run")
  .requiredOption(
    "-p, --prompt <instruction>",
    "Instruction the agent runs when the automation fires",
  )
  .option("--description <text>", "Optional description")
  .option("--cron <expression>", 'Add a cron trigger (e.g. "0 9 * * *")')
  .option(
    "--once <iso-time>",
    'Add a one-time trigger (e.g. "2026-06-10T09:00")',
  )
  .option("--loop <duration>", "Add a loop trigger (e.g. 15m, 1h, 90s)")
  .option("-z, --timezone <tz>", "IANA timezone for --cron / --once")
  .addHelpText(
    "after",
    `
Examples:
  Daily at 9am:   zero automation create -n alerts --agent my-agent -p "..." --cron "0 9 * * *"
  One-time:       zero automation create -n alerts --agent my-agent -p "..." --once "2026-06-10T09:00" -z UTC
  Every 15 min:   zero automation create -n alerts --agent my-agent -p "..." --loop 15m

Notes:
  - Exactly one of --cron, --once, --loop is required`,
  )
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      const trigger = buildInlineTrigger(options);

      const compose = await resolveCompose(options.agent);
      if (!compose) {
        throw new Error(`Agent not found: ${options.agent}`);
      }

      const { automation } = await createAutomation({
        name: options.name,
        agentId: compose.id,
        instruction: options.prompt,
        description: options.description,
        chatThreadId: process.env.ZERO_CHAT_THREAD_ID,
        trigger,
      });

      console.log(chalk.green(`✓ Automation "${automation.name}" created`));
      console.log(chalk.dim(`  ID:     ${automation.id}`));
      console.log(chalk.dim(`  Agent:  ${compose.name}`));
      console.log(chalk.dim(`  Thread: ${automation.chatThreadId}`));

      const createdTrigger = automation.triggers[0];
      if (createdTrigger) {
        console.log(
          chalk.dim(
            `  Trigger: ${createdTrigger.kind} ${formatTriggerConfig(createdTrigger)} (${createdTrigger.id})`,
          ),
        );
      }

      console.log();
      console.log(
        `  Run manually:  ${chalk.cyan(`zero automation run ${automation.name}`)}`,
      );
    }),
  );
