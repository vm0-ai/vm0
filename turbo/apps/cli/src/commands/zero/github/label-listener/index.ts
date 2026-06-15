import { Command } from "commander";
import chalk from "chalk";
import type {
  GithubLabelListener,
  GithubLabelTriggerMode,
  UpdateGithubLabelListenerBody,
} from "@vm0/api-contracts/contracts/integrations-github";
import {
  createGithubLabelListener,
  deleteGithubLabelListener,
  getGithubInstallation,
  updateGithubLabelListener,
} from "../../../../lib/api";
import { withErrorHandler } from "../../../../lib/command";

function parseTriggerMode(value: string): GithubLabelTriggerMode {
  if (value === "created_by_me" || value === "anyone") {
    return value;
  }
  throw new Error("trigger-mode must be one of: created_by_me, anyone");
}

function enabledLabel(listener: GithubLabelListener): string {
  return listener.enabled ? chalk.green("yes") : chalk.dim("no");
}

function manageableLabel(listener: GithubLabelListener): string {
  return listener.canManage ? chalk.green("yes") : chalk.dim("no");
}

function printListeners(listeners: readonly GithubLabelListener[]): void {
  if (listeners.length === 0) {
    console.log(chalk.dim("No GitHub label listeners found"));
    return;
  }

  const idWidth = Math.max(
    2,
    ...listeners.map((listener) => {
      return listener.id.length;
    }),
  );
  const labelWidth = Math.max(
    5,
    ...listeners.map((listener) => {
      return listener.labelName.length;
    }),
  );
  const agentWidth = Math.max(
    5,
    ...listeners.map((listener) => {
      return (listener.agent?.name ?? "-").length;
    }),
  );

  console.log(
    chalk.dim(
      [
        "ID".padEnd(idWidth),
        "LABEL".padEnd(labelWidth),
        "AGENT".padEnd(agentWidth),
        "TRIGGER".padEnd(13),
        "ENABLED",
        "CAN MANAGE",
      ].join("  "),
    ),
  );

  for (const listener of listeners) {
    console.log(
      [
        listener.id.padEnd(idWidth),
        listener.labelName.padEnd(labelWidth),
        (listener.agent?.name ?? "-").padEnd(agentWidth),
        listener.triggerMode.padEnd(13),
        enabledLabel(listener).padEnd(7),
        manageableLabel(listener),
      ].join("  "),
    );
  }
}

const listCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List GitHub label listeners for the active organization")
  .option("--json", "Print raw JSON")
  .action(
    withErrorHandler(async (options: { json?: boolean }) => {
      const installation = await getGithubInstallation();
      if (options.json) {
        console.log(JSON.stringify(installation.labelListeners));
        return;
      }
      printListeners(installation.labelListeners);
    }),
  );

const createCommand = new Command()
  .name("create")
  .description("Create a GitHub label listener")
  .requiredOption("--label <name>", "GitHub label name to watch")
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to run when the label is applied",
  )
  .requiredOption("--prompt <text>", "Prompt to pass to the agent")
  .option(
    "--trigger-mode <mode>",
    "Who can trigger the listener: anyone | created_by_me",
    "anyone",
  )
  .option("--disabled", "Create the listener disabled")
  .option("--json", "Print raw JSON")
  .action(
    withErrorHandler(
      async (options: {
        label: string;
        agentId: string;
        prompt: string;
        triggerMode: string;
        disabled?: boolean;
        json?: boolean;
      }) => {
        const result = await createGithubLabelListener({
          labelName: options.label,
          agentId: options.agentId,
          prompt: options.prompt,
          triggerMode: parseTriggerMode(options.triggerMode),
          enabled: options.disabled ? false : undefined,
        });

        if (options.json) {
          console.log(JSON.stringify(result.listener));
          return;
        }
        console.log(`Created GitHub label listener ${result.listener.id}`);
      },
    ),
  );

const updateCommand = new Command()
  .name("update")
  .alias("edit")
  .description("Update a GitHub label listener")
  .argument("<listener-id>", "GitHub label listener ID")
  .option("--label <name>", "New GitHub label name")
  .option("--agent-id <id>", "New agent ID")
  .option("--prompt <text>", "New prompt")
  .option(
    "--trigger-mode <mode>",
    "Who can trigger the listener: anyone | created_by_me",
  )
  .option("--enable", "Enable the listener")
  .option("--disable", "Disable the listener")
  .option("--json", "Print raw JSON")
  .action(
    withErrorHandler(
      async (
        listenerId: string,
        options: {
          label?: string;
          agentId?: string;
          prompt?: string;
          triggerMode?: string;
          enable?: boolean;
          disable?: boolean;
          json?: boolean;
        },
      ) => {
        if (options.enable && options.disable) {
          throw new Error("Use only one of --enable or --disable");
        }

        const body: UpdateGithubLabelListenerBody = {};
        if (options.label !== undefined) body.labelName = options.label;
        if (options.agentId !== undefined) body.agentId = options.agentId;
        if (options.prompt !== undefined) body.prompt = options.prompt;
        if (options.triggerMode !== undefined) {
          body.triggerMode = parseTriggerMode(options.triggerMode);
        }
        if (options.enable) body.enabled = true;
        if (options.disable) body.enabled = false;

        if (Object.keys(body).length === 0) {
          throw new Error(
            "Provide at least one change: --label, --agent-id, --prompt, --trigger-mode, --enable, or --disable",
          );
        }

        const result = await updateGithubLabelListener(listenerId, body);
        if (options.json) {
          console.log(JSON.stringify(result.listener));
          return;
        }
        console.log(`Updated GitHub label listener ${result.listener.id}`);
      },
    ),
  );

const deleteCommand = new Command()
  .name("delete")
  .alias("rm")
  .description("Delete a GitHub label listener")
  .argument("<listener-id>", "GitHub label listener ID")
  .option("--json", "Print raw JSON")
  .action(
    withErrorHandler(
      async (listenerId: string, options: { json?: boolean }) => {
        const result = await deleteGithubLabelListener(listenerId);
        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }
        console.log(`Deleted GitHub label listener ${listenerId}`);
      },
    ),
  );

export const labelListenerCommand = new Command()
  .name("label-listener")
  .alias("label-listeners")
  .alias("labels")
  .description("Manage GitHub label listeners")
  .addCommand(listCommand)
  .addCommand(createCommand)
  .addCommand(updateCommand)
  .addCommand(deleteCommand)
  .addHelpText(
    "after",
    `
Examples:
  List listeners:    zero github label-listener list
  Create listener:  zero github label-listener create --label zero --agent-id <agent-id> --prompt "Handle this issue"
  Edit listener:    zero github label-listener update <listener-id> --disable
  Delete listener:  zero github label-listener delete <listener-id>

Notes:
  - Updating or deleting a listener is allowed only for the listener owner or an org admin.`,
  );
