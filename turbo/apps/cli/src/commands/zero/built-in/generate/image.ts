import { createImageGenerateCommand } from "../../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  usageCommand: "zero built-in generate image",
  examples: `  Styled image:          zero built-in generate image --style vm0:image-style:notion-illustration --prompt "A product manager mapping a launch plan"
  Skip style:            zero built-in generate image --skip-style --prompt "A watercolor fox"
  Pipe prompt:           cat prompt.txt | zero built-in generate image --skip-style
  GPT Image model:       zero built-in generate image --skip-style --model gpt-image-1.5 --prompt "A poster" --size 1024x1536 --quality high
  Flux model:            zero built-in generate image --skip-style --model flux-pro-1.1 --prompt "A product hero shot" --seed 42
  Image-to-image:        zero built-in generate image --skip-style --model flux-pro-1.1 --image-url https://example.com/mockup.png --prompt "Turn this mockup into a polished product shot"`,
});
