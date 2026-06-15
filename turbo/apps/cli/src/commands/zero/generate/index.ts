import { Command } from "commander";
import { imageCommand } from "./image";
import {
  dashboardDesignCommand,
  docsDesignCommand,
  mobileAppDesignCommand,
  posterCommand,
  reportCommand,
} from "./artifacts";
import { presentationCommand } from "./presentation";
import { spriteCommand } from "./sprite";
import { videoCommand } from "./video";
import { websiteCommand } from "./website";
import { voiceCommand } from "./voice";
import { createListerOnlyCommand } from "./lister-only";

const musicCommand = createListerOnlyCommand({
  name: "music",
  generationType: "music",
  description: "List connectors that provide music generation",
});

const textCommand = createListerOnlyCommand({
  name: "text",
  generationType: "text",
  description: "List connectors that provide text generation",
});

const codeCommand = createListerOnlyCommand({
  name: "code",
  generationType: "code",
  description: "List connectors that provide code generation",
});

const documentCommand = createListerOnlyCommand({
  name: "document",
  generationType: "document",
  description: "List connectors that provide document generation",
});

function buildGenerateHelpText(): string {
  const examples = [
    '  Generate image:        zero generate image --prompt "A watercolor fox"',
    '  Generate deck:         zero generate presentation --prompt "A product roadmap"',
    '  Generate report:       zero generate report --prompt "A Q2 usage report"',
    '  Generate docs:         zero generate docs-design --prompt "A setup guide"',
    '  Generate video:        zero generate video --prompt "A cinematic city shot"',
    '  Generate site:         zero generate website --prompt "A launch site"',
    '  Generate sprite:       zero generate sprite --prompt "A slime monster idle loop"',
    '  Generate speech:       zero generate voice --prompt "Hello"',
    "  Show music choices:    zero generate music",
    "",
    "  Show image choices:    zero generate image",
    "  Show report choices:   zero generate report",
    "  Use a connector:       zero generate video --provider heygen",
    "  Force built-in:        zero generate image --provider built-in --model gpt-image-1.5 --prompt ...",
  ];

  return `\nExamples:\n${examples.join("\n")}\n\nNotes:\n  - Run "zero generate <type>" with no --prompt to list generation choices for that type.
  - Media and connector-backed generation types may expose --provider for vm0 or connector execution guidance.
  - HTML artifact types use registry-backed --design-system and --template selection.`;
}

export const generateCommand = new Command()
  .name("generate")
  .description(
    "Generate assets via vm0's built-in pipelines or get connector skill-invocation guidance",
  )
  .addCommand(imageCommand)
  .addCommand(presentationCommand)
  .addCommand(reportCommand)
  .addCommand(docsDesignCommand)
  .addCommand(posterCommand)
  .addCommand(dashboardDesignCommand)
  .addCommand(mobileAppDesignCommand)
  .addCommand(videoCommand)
  .addCommand(websiteCommand)
  .addCommand(spriteCommand)
  .addCommand(voiceCommand)
  .addCommand(musicCommand)
  .addCommand(textCommand)
  .addCommand(codeCommand)
  .addCommand(documentCommand)
  .addHelpText("after", buildGenerateHelpText);
