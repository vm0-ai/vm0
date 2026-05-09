import { createImageGenerateCommand } from "../../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  usageCommand: "zero built-in generate image",
  examples: `  Generate image:        zero built-in generate image --prompt "A watercolor fox"
  Pipe prompt:           cat prompt.txt | zero built-in generate image
  Pick size/quality:     zero built-in generate image --prompt "A poster" --size 1024x1536 --quality high`,
});
