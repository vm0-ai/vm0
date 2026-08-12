import { createPresentationGenerateCommand } from "../shared/presentation-generate";

export const presentationCommand = createPresentationGenerateCommand({
  name: "presentation",
  generationType: "presentation",
  usageCommand: "okou generate presentation",
  examples: `  Generate deck:         okou generate presentation --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | okou generate presentation
  Pick slide count:      okou generate presentation --slides 10 --prompt "A product launch narrative"
  Custom site slug:      okou generate presentation --site-slug api-migration-plan --prompt "API migration plan"
  Show choices:          okou generate presentation`,
});
