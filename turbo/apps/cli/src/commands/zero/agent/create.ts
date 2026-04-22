import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { zeroAgentCustomSkillNameSchema } from "@vm0/core";
import { createZeroAgent, updateZeroAgentInstructions } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

const SKIN_MAP: Record<string, number> = {
  light: 0,
  "light-medium": 1,
  medium: 2,
  "medium-dark": 3,
  dark: 4,
};

const HAIR_COLOR_MAP: Record<string, number> = {
  blonde: 1,
  teal: 2,
  grey: 3,
  pink: 4,
  brown: 5,
};

const EXPRESSION_MAP: Record<string, number> = {
  calm: 1,
  content: 2,
  neutral: 3,
  pleasant: 4,
  excited: 5,
};

const INTENSITY_MAP: Record<string, "d" | "m" | "h"> = {
  chill: "d",
  normal: "m",
  hyped: "h",
};

function lookupRequired<T>(
  value: string,
  map: Readonly<Record<string, T>>,
  flag: string,
): T {
  if (!(value in map)) {
    throw new Error(
      `Invalid ${flag} "${value}". Must be one of: ${Object.keys(map).join(", ")}`,
    );
  }
  return map[value]!;
}

interface AvatarOptions {
  avatar?: string;
  avatarRotation?: string;
  avatarSkin?: string;
  avatarHairStyle?: string;
  avatarHairColor?: string;
  avatarExpression?: string;
  avatarIntensity?: string;
}

function resolveAvatarUrl(opts: AvatarOptions): string | undefined {
  const hasPreset = opts.avatar !== undefined;
  const hasCustom =
    opts.avatarRotation !== undefined ||
    opts.avatarSkin !== undefined ||
    opts.avatarHairStyle !== undefined ||
    opts.avatarHairColor !== undefined ||
    opts.avatarExpression !== undefined ||
    opts.avatarIntensity !== undefined;

  if (!hasPreset && !hasCustom) return undefined;

  if (hasPreset && hasCustom) {
    throw new Error(
      "--avatar cannot be combined with --avatar-* attribute options",
    );
  }

  if (hasPreset) {
    if (!/^preset:[0-4]$/.test(opts.avatar!)) {
      throw new Error(
        `Invalid --avatar "${opts.avatar}". Use preset:0 through preset:4`,
      );
    }
    return opts.avatar;
  }

  let r = 3;
  if (opts.avatarRotation !== undefined) {
    const n = Number(opts.avatarRotation);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new Error(
        `Invalid --avatar-rotation "${opts.avatarRotation}". Must be 1–5`,
      );
    }
    r = n;
  }

  let h = 1;
  if (opts.avatarHairStyle !== undefined) {
    const n = Number(opts.avatarHairStyle);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new Error(
        `Invalid --avatar-hair-style "${opts.avatarHairStyle}". Must be 1–5`,
      );
    }
    h = n;
  }

  const s =
    opts.avatarSkin !== undefined
      ? lookupRequired(opts.avatarSkin, SKIN_MAP, "--avatar-skin")
      : 2;
  const c =
    opts.avatarHairColor !== undefined
      ? lookupRequired(opts.avatarHairColor, HAIR_COLOR_MAP, "--avatar-hair-color")
      : 5;
  const f =
    opts.avatarExpression !== undefined
      ? lookupRequired(opts.avatarExpression, EXPRESSION_MAP, "--avatar-expression")
      : 1;
  const i =
    opts.avatarIntensity !== undefined
      ? lookupRequired(opts.avatarIntensity, INTENSITY_MAP, "--avatar-intensity")
      : "m";

  return `svg:r${r}s${s}h${h}c${c}f${f}${i}`;
}

export const createCommand = new Command()
  .name("create")
  .description("Create a new zero agent")
  .option(
    "--skills <items>",
    "Comma-separated custom skill names to attach (e.g. my-skill,other-skill)",
  )
  .option("--display-name <name>", "Agent display name")
  .option("--description <text>", "Agent description")
  .option(
    "--sound <tone>",
    "Agent tone: professional, friendly, direct, supportive",
  )
  .option("--avatar <preset>", "Avatar preset: preset:0 through preset:4")
  .option("--avatar-rotation <1-5>", "Head angle: 1=far-left  3=center  5=far-right")
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
  .option("--instructions-file <path>", "Path to instructions file")
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

  Custom attributes (--avatar-* flags, omitted fields use defaults):
    --avatar-rotation   1=far-left  3=center(default)  5=far-right
    --avatar-skin       light / light-medium / medium(default) / medium-dark / dark
    --avatar-hair-style 1–5 (default: 1)
    --avatar-hair-color blonde / teal / grey / pink / brown(default)
    --avatar-expression calm(default) / content / neutral / pleasant / excited
    --avatar-intensity  chill / normal(default) / hyped

  Note: --avatar and --avatar-* cannot be used together.

Examples:
  Minimal:               zero agent create --display-name "My Agent"
  Quick preset:          zero agent create --display-name "My Agent" --avatar preset:2
  Custom avatar:         zero agent create --display-name "My Agent" --avatar-skin dark --avatar-hair-color teal --avatar-intensity hyped
  With skills:           zero agent create --skills my-skill,other-skill --display-name "My Agent"
  With instructions:     zero agent create --display-name "My Agent" --instructions-file ./instructions.md`,
  )
  .action(
    withErrorHandler(
      async (options: {
        skills?: string;
        displayName?: string;
        description?: string;
        sound?: string;
        avatar?: string;
        avatarRotation?: string;
        avatarSkin?: string;
        avatarHairStyle?: string;
        avatarHairColor?: string;
        avatarExpression?: string;
        avatarIntensity?: string;
        instructionsFile?: string;
      }) => {
        const customSkills = options.skills
          ? options.skills.split(",").map((s) => {
              return s.trim();
            })
          : undefined;

        if (customSkills) {
          for (const name of customSkills) {
            const result = zeroAgentCustomSkillNameSchema.safeParse(name);
            if (!result.success) {
              throw new Error(
                `Invalid skill name "${name}": must be 2-64 characters, lowercase alphanumeric and hyphens only (e.g. my-skill)`,
              );
            }
          }
        }

        const avatarUrl = resolveAvatarUrl(options);

        const agent = await createZeroAgent({
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
          avatarUrl,
          customSkills,
        });

        if (options.instructionsFile) {
          const content = readFileSync(options.instructionsFile, "utf-8");
          await updateZeroAgentInstructions(agent.agentId, content);
        }

        console.log(chalk.green(`✓ Agent "${agent.agentId}" created`));
        console.log(`  Agent ID:     ${agent.agentId}`);
        if (customSkills?.length) {
          console.log(`  Skills:       ${customSkills.join(", ")}`);
        }
        if (agent.displayName) {
          console.log(`  Display Name: ${agent.displayName}`);
        }

        console.log();
        console.log("Next steps to authorize connectors for this agent:");
        console.log("  - Search connectors this agent needs:");
        console.log(
          `      zero connector search <keyword> --agent ${agent.agentId}`,
        );
        console.log(
          "  - Check authorization status (prints an authorize URL if not authorized):",
        );
        console.log(
          `      zero connector status <type> --agent ${agent.agentId}`,
        );
      },
    ),
  );
