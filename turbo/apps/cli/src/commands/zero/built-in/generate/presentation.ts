import { createPresentationGenerateCommand } from "../../shared/presentation-generate";

export const presentationCommand = createPresentationGenerateCommand({
  name: "presentation",
  usageCommand: "zero built-in generate presentation",
  examples: `  Generate deck:         zero built-in generate presentation --prompt "A strategy deck for reducing support volume"
  Pipe prompt:           cat brief.txt | zero built-in generate presentation
  Swiss style:           zero built-in generate presentation --style swiss --theme ikb --slides 10 --images 8 --image-model gpt-image-1.5 --prompt "A product launch narrative"
  Audience context:      zero built-in generate presentation --audience "engineering leadership" --prompt "API migration plan"`,
});
