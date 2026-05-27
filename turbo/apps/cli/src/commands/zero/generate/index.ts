import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Command } from "commander";
import { zeroTokenAllowsFeatureSwitch } from "../../../lib/api/zero-token";
import { imageCommand } from "./image";
import {
  dashboardDesignCommand,
  docsDesignCommand,
  mobileAppDesignCommand,
  posterCommand,
  reportCommand,
} from "./open-design-artifacts";
import { presentationCommand } from "./presentation";
import { videoCommand } from "./video";
import { websiteCommand } from "./website";
import { voiceCommand } from "./voice";
import { createListerOnlyCommand } from "./lister-only";

const audioCommand = createListerOnlyCommand({
  name: "audio",
  generationType: "audio",
  description:
    "List connectors that provide audio generation (alias of voice for non-speech audio)",
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
    ...(zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.HostedSites)
      ? [
          '  Generate site:         zero generate website --prompt "A launch site"',
        ]
      : []),
    '  Generate speech:       zero generate voice --prompt "Hello"',
    "",
    "  List image providers:  zero generate image",
    "  Use a connector:       zero generate video --provider heygen",
    "  Force built-in:        zero generate image --provider built-in --model gpt-image-1.5 --prompt ...",
  ];

  return `\nExamples:\n${examples.join("\n")}\n\nNotes:\n  - Run "zero generate <type>" with no --prompt to list every provider available for that type.\n  - --provider built-in (default when --prompt is provided) runs the vm0-hosted pipeline.\n  - --provider <connector-name> prints how to invoke that connector's skill instead.`;
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
  .addCommand(
    websiteCommand,
    zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.HostedSites)
      ? {}
      : { hidden: true },
  )
  .addCommand(voiceCommand)
  .addCommand(audioCommand)
  .addCommand(textCommand)
  .addCommand(codeCommand)
  .addCommand(documentCommand)
  .addHelpText("after", buildGenerateHelpText);
