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
  avatar?: string;
  skills?: string;
  addSkill?: string;
  removeSkill?: string;
  instructionsFile?: string;
  modelProvider?: string;
  model?: string;
}

function validateAvatar(value: string): void {
  if (/^preset:[0-4]$/.test(value)) return;
  if (/^svg:r[1-5]s[0-4]h[1-5]c[1-5]f[1-5][dmh]$/.test(value)) return;
  throw new Error(
    `Invalid avatar "${value}". Use preset:0–4 or svg:r{1-5}s{0-4}h{1-5}c{1-5}f{1-5}{d|m|h} (e.g. svg:r3s1h2c2f4h)`,
  );
}

function hasAgentFieldUpdate(options: AgentEditOptions): boolean {
  return (
    options.displayName !== undefined ||
    options.description !== undefined ||
    options.sound !== undefined ||
    options.avatar !== undefined ||
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
    avatarUrl:
      options.avatar !== undefined
        ? options.avatar
        : (current.avatarUrl ?? undefined),
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
  .option("--avatar <config>", "Agent avatar (preset:0–4 or custom svg: string)")
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
Avatar format:
  Presets:
    preset:0  light skin, brown hair, calm, hyped
    preset:1  light-medium skin, grey hair, calm, normal
    preset:2  medium skin, pink hair, neutral, chill
    preset:3  medium-dark skin, blonde hair, pleasant, hyped
    preset:4  dark skin, teal hair, excited, normal
  Custom: svg:r{R}s{S}h{H}c{C}f{F}{I}
    R  head angle   1=far-left  3=center  5=far-right
    S  skin tone    0=lightest  2=medium  4=darkest
    H  hair style   1–5
    C  hair color   1=blonde  2=teal  3=grey  4=pink  5=brown
    F  expression   1=calm  3=neutral  5=excited
    I  intensity    d=chill  m=normal  h=hyped

Examples:
  Update description:      zero agent edit <agent-id> --description "new role"
  Update tone:             zero agent edit <agent-id> --sound friendly
  Set avatar:              zero agent edit <agent-id> --avatar preset:2
  Custom avatar:           zero agent edit <agent-id> --avatar svg:r3s1h2c2f4h
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
          "At least one option is required (--display-name, --description, --sound, --avatar, --skills, --add-skill, --remove-skill, --model-provider, --model, --instructions-file)",
        );
      }

      if (options.avatar !== undefined) {
        validateAvatar(options.avatar);
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
