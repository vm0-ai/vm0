/**
 * Firewall config generator entry point.
 *
 * Usage:
 *   tsx src/index.ts           # generate all
 *   tsx src/index.ts github    # generate github only
 */

import { generate as generateAgentmail } from "./agentmail";
import { generate as generateAhrefs } from "./ahrefs";
import { generate as generateAirtable } from "./airtable";
import { generate as generateConfluence } from "./confluence";
import { generate as generateFigma } from "./figma";
import { generate as generateGitHub } from "./github";
import { generate as generateJira } from "./jira";
import { generate as generateNotion } from "./notion";
import { generate as generateSlack } from "./slack";
import { generate as generateVercel } from "./vercel";
import { generate as generateZapsign } from "./zapsign";
import { generate as generateZeptomail } from "./zeptomail";
import { createGoogleGenerator, googleServiceNames } from "./google";

const GENERATORS: Record<string, () => Promise<void>> = {
  agentmail: generateAgentmail,
  ahrefs: generateAhrefs,
  airtable: generateAirtable,
  confluence: generateConfluence,
  figma: generateFigma,
  github: generateGitHub,
  jira: generateJira,
  notion: generateNotion,
  slack: generateSlack,
  vercel: generateVercel,
  zapsign: generateZapsign,
  zeptomail: generateZeptomail,
  ...Object.fromEntries(
    googleServiceNames.map((name) => [name, createGoogleGenerator(name)]),
  ),
};

async function main(): Promise<void> {
  const target = process.argv[2];

  if (target) {
    const gen = GENERATORS[target];
    if (!gen) {
      console.error(
        `Unknown generator: ${target}. Available: ${Object.keys(GENERATORS).join(", ")}`,
      );
      process.exit(1);
    }
    await gen();
  } else {
    // Run all generators
    for (const [name, gen] of Object.entries(GENERATORS)) {
      console.error(`\n=== ${name} ===`);
      await gen();
    }
  }

  console.error("\nDone.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
