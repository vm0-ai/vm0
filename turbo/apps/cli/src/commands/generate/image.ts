import { createImageGenerateCommand } from "../shared/image-generate";

export const imageCommand = createImageGenerateCommand({
  name: "image",
  generationType: "image",
  usageCommand: "okou generate image",
  examples: `  Compile styled prompt: okou generate image --style image-style:notion-illustration --prompt "A product manager mapping a launch plan" --compile
  Generate compiled:     okou generate image --compiled-prompt "A Notion-style brush-pen illustration..."
  Generate raw:          okou generate image --raw-prompt "A watercolor fox"
  Pipe compile prompt:   cat prompt.txt | okou generate image --style image-style:notion-illustration --compile
  GPT Image model:       okou generate image --compiled-prompt "A poster" --model gpt-image-1.5 --size 1024x1536 --quality high
  Flux model:            okou generate image --raw-prompt "A product hero shot" --model flux-pro-1.1 --seed 42
  Nano Banana 2:         okou generate image --compiled-prompt "A crisp launch poster with readable typography" --model nano-banana-2
  Image-to-image:        okou generate image --compiled-prompt "Turn this mockup into a polished product shot" --model flux-pro-1.1 --image-url https://example.com/mockup.png
  List providers:        okou generate image
  Use a connector:       okou generate image --provider replicate`,
});
