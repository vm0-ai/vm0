import { createImageGenerateCommand } from "../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  generationType: "image",
  usageCommand: "zero generate image",
  examples: `  Compile styled prompt: zero generate image --style image-style:notion-illustration --prompt "A product manager mapping a launch plan" --compile
  Generate compiled:     zero generate image --compiled-prompt "A Notion-style brush-pen illustration..."
  Generate raw:          zero generate image --raw-prompt "A watercolor fox"
  Pipe compile prompt:   cat prompt.txt | zero generate image --style image-style:notion-illustration --compile
  GPT Image model:       zero generate image --compiled-prompt "A poster" --model gpt-image-1.5 --size 1024x1536 --quality high
  Flux model:            zero generate image --raw-prompt "A product hero shot" --model flux-pro-1.1 --seed 42
  Nano Banana 2:         zero generate image --compiled-prompt "A crisp launch poster with readable typography" --model nano-banana-2
  Image-to-image:        zero generate image --compiled-prompt "Turn this mockup into a polished product shot" --model flux-pro-1.1 --image-url https://example.com/mockup.png
  List providers:        zero generate image
  Use a connector:       zero generate image --provider replicate`,
});
