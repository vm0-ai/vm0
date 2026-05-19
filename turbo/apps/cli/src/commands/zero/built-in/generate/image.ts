import { createImageGenerateCommand } from "../../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  usageCommand: "zero built-in generate image",
  examples: `  Generate image:        zero built-in generate image --prompt "A watercolor fox"
  Pipe prompt:           cat prompt.txt | zero built-in generate image
  GPT Image model:       zero built-in generate image --model gpt-image-1.5 --prompt "A poster" --size 1024x1536 --quality high
  Flux model:            zero built-in generate image --model flux-pro-1.1 --prompt "A product hero shot" --seed 42
  Image-to-image:        zero built-in generate image --model flux-pro-1.1 --image-url https://example.com/mockup.png --prompt "Turn this mockup into a polished product shot"`,
});
