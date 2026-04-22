import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { zeroAgentCustomSkillNameSchema } from "@vm0/core";
import { createZeroAgent, updateZeroAgentInstructions } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function validateAvatar(value: string): void {
  if (/^preset:[0-4]$/.test(value)) return;
  if (/^svg:r[1-5]s[0-4]h[1-5]c[1-5]f[1-5][dmh]$/.test(value)) return;
  throw new Error(
    `Invalid avatar "${value}". Use preset:0–4 or svg:r{1-5}s{0-4}h{1-5}c{1-5}f{1-5}{d|m|h} (e.g. svg:r3s1h2c2f4h)`,
  );
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
  .option("--avatar <config>", "Agent avatar (preset:0–4 or custom svg: string)")
  .option("--instructions-file <path>", "Path to instructions file")
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
  Minimal:               zero agent create --display-name "My Agent"
  With avatar:           zero agent create --display-name "My Agent" --avatar preset:2
  Custom avatar:         zero agent create --display-name "My Agent" --avatar svg:r3s1h2c2f4h
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

        if (options.avatar !== undefined) {
          validateAvatar(options.avatar);
        }

        const agent = await createZeroAgent({
          displayName: options.displayName,
          description: options.description,
          sound: options.sound,
          avatarUrl: options.avatar,
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
