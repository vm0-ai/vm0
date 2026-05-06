import { createImageGenerateCommand } from "../../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  usageCommand: "zero official generate image",
  examples: `  Generate image:        zero official generate image --prompt "A watercolor fox"
  Pipe prompt:           cat prompt.txt | zero official generate image
  Pick size/quality:     zero official generate image --prompt "A poster" --size 1024x1536 --quality high`,
});
