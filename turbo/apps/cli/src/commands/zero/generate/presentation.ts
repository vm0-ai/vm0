import { createPresentationGenerateCommand } from "../shared/presentation-generate";

export const presentationCommand = createPresentationGenerateCommand({
  name: "presentation",
  generationType: "presentation",
  usageCommand: "zero generate presentation",
  examples: `  Generate deck:         zero generate presentation --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | zero generate presentation
  Generated visuals:     zero generate presentation --slides 10 --images 8 --image-model gpt-image-1.5 --prompt "A product launch narrative"
  Stable hosted slug:    zero generate presentation --site-slug api-migration-plan --prompt "API migration plan"
  List providers:        zero generate presentation`,
});
