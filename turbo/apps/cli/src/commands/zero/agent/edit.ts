import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { zeroAgentCustomSkillNameSchema } from "@vm0/core";
import {
  getZeroAgent,
  updateZeroAgent,
  updateZeroAgentInstructions,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { parseModelFlag } from "../../../lib/domain/model-provider/shared";

interface AgentEditOptions {
  displayName?: string;
  description?: string;
  sound?: string;
  skills?: string;
  addSkill?: string;
  removeSkill?: string;
  instructionsFile?: string;
  modelProvider?: string;
  model?: string;
}

function hasAgentFieldUpdate(options: AgentEditOptions): boolean {
  return (
    options.displayName !== undefined ||
    options.description !== undefined ||
    options.sound !== undefined ||
    options.skills !== undefined ||
    options.addSkill !== undefined ||
    options.removeSkill !== undefined ||
    options.modelProvider !== undefined ||
    options.model !== undefined
  );
}

async function applyAgentUpdate(
  agentId: string,
  options: AgentEditOptions,
): Promise<void> {
  const current = await getZeroAgent(agentId);
  const customSkills = resolveCustomSkills(options, current.customSkills ?? []);

  const modelProviderId =
    options.modelProvider !== undefined
      ? parseModelFlag(options.modelProvider)
      : current.modelProviderId;
  const selectedModel =
    options.model !== undefined
      ? parseModelFlag(options.model)
      : current.selectedModel;

  await updateZeroAgent(agentId, {
    displayName:
      options.displayName !== undefined
        ? options.displayName
        : (current.displayName ?? undefined),
    description:
      options.description !== undefined
        ? options.description
        : (current.description ?? undefined),
    sound:
      options.sound !== undefined
        ? options.sound
        : (current.sound ?? undefined),
    customSkills,
    modelProviderId,
    selectedModel,
  });
}

function validateSkillName(name: string): void {
  const result = zeroAgentCustomSkillNameSchema.safeParse(name);
  if (!result.success) {
    throw new Error(
      `Invalid skill name "${name}": must be 2-64 characters, lowercase alphanumeric and hyphens only (e.g. my-skill)`,
    );
  }
}

function resolveCustomSkills(
  options: { skills?: string; addSkill?: string; removeSkill?: string },
  existing: string[],
): string[] | undefined {
  if (options.skills && (options.addSkill || options.removeSkill)) {
    throw new Error("Cannot use --skills with --add-skill or --remove-skill");
  }

  if (options.skills) {
    const names = options.skills.split(",").map((s) => {
      return s.trim();
    });
    for (const name of names) {
      validateSkillName(name);
    }
    return names;
  }

  if (options.addSkill) {
    validateSkillName(options.addSkill);
    if (existing.includes(options.addSkill)) {
      throw new Error(
        `Skill "${options.addSkill}" is already attached to this agent`,
      );
    }
    return [...existing, options.addSkill];
  }

  if (options.removeSkill) {
    if (!existing.includes(options.removeSkill)) {
      throw new Error(
        `Skill "${options.removeSkill}" is not attached to this agent`,
      );
    }
    return existing.filter((s) => {
      return s !== options.removeSkill;
    });
  }

  return undefined;
}

export const editCommand = new Command()
  .name("edit")
  .description("Edit a zero agent")
  .argument("<agent-id>", "Agent ID")
  .option("--display-name <name>", "New display name")
  .option("--description <text>", "New description")
  .option(
    "--sound <tone>",
    "New tone: professional, friendly, direct, supportive",
  )
  .option(
    "--skills <items>",
    "Comma-separated custom skill names to attach (replaces existing)",
  )
  .option("--add-skill <name>", "Add a custom skill to the agent")
  .option("--remove-skill <name>", "Remove a custom skill from the agent")
  .option("--instructions-file <path>", "Path to new instructions file")
  .option(
    "--model-provider <id>",
    "Model provider UUID, or 'default' to inherit org default",
  )
  .option(
    "--model <name>",
    "Model name (e.g. claude-sonnet-4-6, MiniMax-M2.7), or 'default' to inherit provider default",
  )
  .addHelpText(
    "after",
    `
Examples:
  Update description:      zero agent edit <agent-id> --description "new role"
  Update tone:             zero agent edit <agent-id> --sound friendly
  Replace all skills:      zero agent edit <agent-id> --skills my-skill,other-skill
  Add a skill:             zero agent edit <agent-id> --add-skill my-skill
  Remove a skill:          zero agent edit <agent-id> --remove-skill my-skill
  Update instructions:     zero agent edit <agent-id> --instructions-file ./instructions.md
  Set model:               zero agent edit <agent-id> --model-provider <provider-id> --model MiniMax-M2.7
  Reset model:             zero agent edit <agent-id> --model-provider default --model default
  Update yourself:         zero agent edit $ZERO_AGENT_ID --description "new role"

Notes:
  - At least one option is required
  - Unspecified fields are preserved (not cleared)
  - --skills replaces the entire skill list; --add-skill/--remove-skill modify incrementally
  - --skills cannot be combined with --add-skill or --remove-skill
  - Use 'zero org model-provider list' to see available providers and models
  - To create or edit skill content, use: zero skill --help`,
  )
  .action(
    withErrorHandler(async (agentId: string, options: AgentEditOptions) => {
      const hasAgentUpdate = hasAgentFieldUpdate(options);

      if (!hasAgentUpdate && !options.instructionsFile) {
        throw new Error(
          "At least one option is required (--display-name, --description, --sound, --skills, --add-skill, --remove-skill, --model-provider, --model, --instructions-file)",
        );
      }

      if (hasAgentUpdate) {
        await applyAgentUpdate(agentId, options);
      }

      if (options.instructionsFile) {
        const content = readFileSync(options.instructionsFile, "utf-8");
        await updateZeroAgentInstructions(agentId, content);
      }

      console.log(chalk.green(`✓ Agent "${agentId}" updated`));
    }),
  );
