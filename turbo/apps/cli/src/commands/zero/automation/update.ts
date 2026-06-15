import { Command } from "commander";
import chalk from "chalk";
import type { UpdateTriggerRequest } from "@vm0/api-contracts/contracts/automations";
import {
  showAutomation,
  updateAutomation,
  updateAutomationTrigger,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { parseDurationSeconds } from "./duration";
import { formatTriggerConfig } from "./trigger-display";

interface UpdateOptions {
  name?: string;
  prompt?: string;
  description?: string;
  cron?: string;
  once?: string;
  loop?: string;
  timezone?: string;
}

/**
 * Build the optional schedule replacement from the timing sugar flags
 * (--cron / --once / --loop, with optional --timezone). The automation's
 * single time trigger is updated in place; its kind switches to match the
 * flag.
 */
function buildTimingUpdate(
  options: UpdateOptions,
): UpdateTriggerRequest | undefined {
  const sugarCount = [options.cron, options.once, options.loop].filter(
    (value) => {
      return value !== undefined;
    },
  ).length;

  if (sugarCount > 1) {
    throw new Error("Use at most one of --cron, --once, --loop");
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
    return { kind: "once", atTime: options.once, timezone: options.timezone };
  }
  if (options.loop) {
    return {
      kind: "loop",
      intervalSeconds: parseDurationSeconds(options.loop),
    };
  }
  return undefined;
}

export const updateCommand = new Command()
  .name("update")
  .description(
    "Update an automation's name, instruction, description, or schedule",
  )
  .argument("<automation>", "Automation ID or name")
  .option("-n, --name <name>", "New automation name")
  .option("-p, --prompt <instruction>", "New instruction")
  .option("--description <text>", "New description")
  .option("--cron <expression>", 'New cron schedule (e.g. "0 9 * * *")')
  .option("--once <iso-time>", 'New one-time fire (e.g. "2026-06-10T09:00")')
  .option("--loop <duration>", "New loop interval (e.g. 15m, 1h, 90s)")
  .option("-z, --timezone <tz>", "IANA timezone for --cron / --once")
  .addHelpText(
    "after",
    `
Examples:
  zero automation update alerts -p "Summarize alerts and post to Slack"
  zero automation update alerts -n alerts-v2 --description "Daily alert digest"
  zero automation update alerts --cron "0 18 * * 5" -z Asia/Shanghai
  zero automation update alerts --loop 10m

Notes:
  - At most one of --cron, --once, --loop; it replaces the automation's single time trigger in place (the kind may switch, run history is kept)
  - With multiple time triggers, address one directly: zero automation trigger update <trigger-id>`,
  )
  .action(
    withErrorHandler(async (ref: string, options: UpdateOptions) => {
      const timing = buildTimingUpdate(options);
      const hasIdentityUpdate =
        options.name !== undefined ||
        options.prompt !== undefined ||
        options.description !== undefined;

      if (!hasIdentityUpdate && !timing) {
        throw new Error(
          "Nothing to update: provide --name, --prompt, --description, --cron, --once, or --loop",
        );
      }

      // Resolve the single time trigger up front so a missing/ambiguous
      // trigger fails before any field is patched.
      let timeTriggerId: string | undefined;
      if (timing) {
        const automation = await showAutomation(ref);
        const timeTriggers = automation.triggers.filter((trigger) => {
          return trigger.kind !== "webhook";
        });
        const [first] = timeTriggers;
        if (!first) {
          throw new Error(
            `No time trigger to update; add one with: zero automation trigger add ${ref} cron --expr "0 9 * * *"`,
          );
        }
        if (timeTriggers.length > 1) {
          const ids = timeTriggers
            .map((trigger) => {
              return trigger.id;
            })
            .join(", ");
          throw new Error(
            `Multiple time triggers; update one explicitly: zero automation trigger update <id> ... (ids: ${ids})`,
          );
        }
        timeTriggerId = first.id;
      }

      if (hasIdentityUpdate) {
        const automation = await updateAutomation(ref, {
          name: options.name,
          instruction: options.prompt,
          description: options.description,
        });
        console.log(chalk.green(`✓ Automation "${automation.name}" updated`));
      }

      if (timing && timeTriggerId) {
        const trigger = await updateAutomationTrigger(timeTriggerId, timing);
        console.log(chalk.green(`✓ Trigger ${trigger.id} updated`));
        console.log(
          chalk.dim(
            `  Schedule: ${trigger.kind} ${formatTriggerConfig(trigger)}`,
          ),
        );
      }
    }),
  );
