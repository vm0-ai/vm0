import { Command } from "commander";
import chalk from "chalk";
import type { UpdateTriggerRequest } from "@vm0/api-contracts/contracts/automations";
import { updateAutomationTrigger } from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";
import { parseDurationSeconds } from "../duration";
import { printTriggerDetails } from "../trigger-display";

interface UpdateOptions {
  expr?: string;
  at?: string;
  every?: string;
  timezone?: string;
}

const EXACTLY_ONE_FLAG_MESSAGE =
  "Provide exactly one of --expr (cron), --at (once), --every (loop)";

/**
 * Build the schedule replacement from exactly one timing flag; the trigger's
 * kind switches to match the flag: --expr → cron, --at → once, --every → loop.
 */
function buildUpdate(options: UpdateOptions): UpdateTriggerRequest {
  const flagCount = [options.expr, options.at, options.every].filter(
    (value) => {
      return value !== undefined;
    },
  ).length;
  if (flagCount > 1) {
    throw new Error(EXACTLY_ONE_FLAG_MESSAGE);
  }
  if (options.timezone && !options.expr && !options.at) {
    throw new Error("--timezone only applies to --expr and --at");
  }

  if (options.expr) {
    return {
      kind: "cron",
      cronExpression: options.expr,
      timezone: options.timezone,
    };
  }
  if (options.at) {
    return { kind: "once", atTime: options.at, timezone: options.timezone };
  }
  if (options.every) {
    return {
      kind: "loop",
      intervalSeconds: parseDurationSeconds(options.every),
    };
  }
  throw new Error(EXACTLY_ONE_FLAG_MESSAGE);
}

export const updateCommand = new Command()
  .name("update")
  .description(
    "Replace a time trigger's schedule in place (kind may switch among cron/once/loop)",
  )
  .argument("<trigger>", "Trigger ID")
  .option("--expr <expression>", 'New cron schedule (e.g. "0 9 * * *")')
  .option("--at <iso-time>", 'New one-time fire (e.g. "2026-06-10T09:00")')
  .option("--every <duration>", "New loop interval (e.g. 15m, 1h, 90s)")
  .option("-z, --timezone <tz>", "IANA timezone for --expr / --at")
  .addHelpText(
    "after",
    `
Examples:
  zero automation trigger update 22222222-2222-4222-8222-222222222222 --expr "0 9 * * *" -z Asia/Shanghai
  zero automation trigger update 22222222-2222-4222-8222-222222222222 --at "2026-06-10T09:00"
  zero automation trigger update 22222222-2222-4222-8222-222222222222 --every 10m

Notes:
  - Exactly one of --expr (cron), --at (once), --every (loop); the trigger's kind switches to match
  - The trigger keeps its id, enabled flag, and run history; the next run is recomputed and the failure counter resets
  - Webhook triggers have no schedule and cannot be updated`,
  )
  .action(
    withErrorHandler(async (id: string, options: UpdateOptions) => {
      const body = buildUpdate(options);

      const trigger = await updateAutomationTrigger(id, body);

      console.log(chalk.green(`✓ Trigger ${trigger.id} updated`));
      printTriggerDetails(trigger);
    }),
  );
