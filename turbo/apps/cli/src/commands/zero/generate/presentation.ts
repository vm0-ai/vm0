import { createPresentationGenerateCommand } from "../shared/presentation-generate";

export const presentationCommand = createPresentationGenerateCommand({
  name: "presentation",
  generationType: "presentation",
  usageCommand: "zero generate presentation",
  examples: `  Generate deck:         zero generate presentation --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | zero generate presentation
  Pick slide count:      zero generate presentation --slides 10 --prompt "A product launch narrative"
  Custom site slug:      zero generate presentation --site-slug api-migration-plan --prompt "API migration plan"
  Show choices:          zero generate presentation`,
});
