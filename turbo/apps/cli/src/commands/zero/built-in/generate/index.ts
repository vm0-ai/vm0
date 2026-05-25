import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Command } from "commander";
import { zeroTokenAllowsFeatureSwitch } from "../../../../lib/api/zero-token";
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

function buildGenerateHelpText(): string {
  const examples = [
    '  Generate image:   zero built-in generate image --prompt "A watercolor fox"',
    '  Generate deck:    zero built-in generate presentation --prompt "A product roadmap"',
    ...(zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.OpenDesignGenerate)
      ? [
          '  Generate report:  zero built-in generate report --prompt "A Q2 usage report"',
          '  Generate docs:    zero built-in generate docs-design --prompt "A setup guide"',
        ]
      : []),
    '  Generate video:   zero built-in generate video --prompt "A cinematic city shot"',
    ...(zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.HostedSites)
      ? [
          '  Generate site:    zero built-in generate website --prompt "A launch site"',
        ]
      : []),
    '  Generate speech:  zero built-in generate voice --text "Hello"',
  ];

  return `\nExamples:\n${examples.join("\n")}`;
}

const openDesignCommandOptions = zeroTokenAllowsFeatureSwitch(
  FeatureSwitchKey.OpenDesignGenerate,
)
  ? {}
  : { hidden: true };

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with built-in vm0 services")
  .addCommand(imageCommand)
  .addCommand(presentationCommand)
  .addCommand(reportCommand, openDesignCommandOptions)
  .addCommand(docsDesignCommand, openDesignCommandOptions)
  .addCommand(posterCommand, openDesignCommandOptions)
  .addCommand(dashboardDesignCommand, openDesignCommandOptions)
  .addCommand(mobileAppDesignCommand, openDesignCommandOptions)
  .addCommand(videoCommand)
  .addCommand(
    websiteCommand,
    zeroTokenAllowsFeatureSwitch(FeatureSwitchKey.HostedSites)
      ? {}
      : { hidden: true },
  )
  .addCommand(voiceCommand)
  .addHelpText("after", buildGenerateHelpText);
