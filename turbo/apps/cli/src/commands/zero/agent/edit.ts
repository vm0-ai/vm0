import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import {
  getZeroAgent,
  updateZeroAgent,
  updateZeroAgentInstructions,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { type AvatarOptions, resolveAvatarUrl } from "./avatar";

interface AgentEditOptions extends AvatarOptions {
  displayName?: string;
  description?: string;
  sound?: string;
  instructionsFile?: string;
}

function hasAvatarUpdate(options: AvatarOptions): boolean {
  return (
    options.avatar !== undefined ||
    options.avatarRotation !== undefined ||
    options.avatarSkin !== undefined ||
    options.avatarHairStyle !== undefined ||
    options.avatarHairColor !== undefined ||
    options.avatarExpression !== undefined ||
    options.avatarIntensity !== undefined
  );
}

function hasAgentFieldUpdate(options: AgentEditOptions): boolean {
  return (
    options.displayName !== undefined ||
    options.description !== undefined ||
    options.sound !== undefined ||
    hasAvatarUpdate(options)
  );
}

async function applyAgentUpdate(
  agentId: string,
  options: AgentEditOptions,
): Promise<void> {
  const hasAvatar = hasAvatarUpdate(options);
  const resolvedAvatarUrl = hasAvatar ? resolveAvatarUrl(options) : undefined;

  const current = await getZeroAgent(agentId);

  const avatarUrl = hasAvatar
    ? resolvedAvatarUrl
    : (current.avatarUrl ?? undefined);

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
    avatarUrl,
  });
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
  .option("--avatar <preset>", "Avatar preset: preset:0 through preset:4")
  .option(
    "--avatar-rotation <1-5>",
    "Head angle: 1=far-left  3=center  5=far-right",
  )
  .option(
    "--avatar-skin <tone>",
    "Skin tone: light | light-medium | medium | medium-dark | dark",
  )
  .option("--avatar-hair-style <1-5>", "Hair style: 1–5")
  .option(
    "--avatar-hair-color <color>",
    "Hair color: blonde | teal | grey | pink | brown",
  )
  .option(
    "--avatar-expression <expr>",
    "Expression: calm | content | neutral | pleasant | excited",
  )
  .option("--avatar-intensity <level>", "Intensity: chill | normal | hyped")
  .option("--instructions-file <path>", "Path to new instructions file")
  .addHelpText(
    "after",
    `
Avatar:
  Quick presets (--avatar):
    preset:0  light skin, brown hair, calm, hyped
    preset:1  light-medium skin, grey hair, calm, normal
    preset:2  medium skin, pink hair, neutral, chill
    preset:3  medium-dark skin, blonde hair, pleasant, hyped
    preset:4  dark skin, teal hair, excited, normal

  Custom attributes (--avatar-* flags, replace the entire avatar):
    --avatar-rotation    1=far-left  3=center(default)  5=far-right
    --avatar-skin        light / light-medium / medium(default) / medium-dark / dark
    --avatar-hair-style  1–5 (default: 1)
    --avatar-hair-color  blonde / teal / grey / pink / brown(default)
    --avatar-expression  calm(default) / content / neutral / pleasant / excited
    --avatar-intensity   chill / normal(default) / hyped

  Note: --avatar and --avatar-* cannot be used together.

Examples:
  Update description:      zero agent edit <agent-id> --description "new role"
  Update tone:             zero agent edit <agent-id> --sound friendly
  Quick preset avatar:     zero agent edit <agent-id> --avatar preset:2
  Custom avatar:           zero agent edit <agent-id> --avatar-skin dark --avatar-hair-color teal --avatar-intensity hyped
  Update instructions:     zero agent edit <agent-id> --instructions-file ./instructions.md
  Update yourself:         zero agent edit $ZERO_AGENT_ID --description "new role"

Notes:
  - At least one option is required
  - Unspecified fields are preserved (not cleared)
  - To attach workflows to agents, use: zero workflow attach --help`,
  )
  .action(
    withErrorHandler(async (agentId: string, options: AgentEditOptions) => {
      const hasAgentUpdate = hasAgentFieldUpdate(options);

      if (!hasAgentUpdate && !options.instructionsFile) {
        throw new Error(
          "At least one option is required (--display-name, --description, --sound, --avatar, --avatar-*, --instructions-file)",
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
