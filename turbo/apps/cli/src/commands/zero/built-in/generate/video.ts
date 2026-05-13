import { createVideoGenerateCommand } from "../../shared/video-generate";

export const videoCommand = createVideoGenerateCommand({
  name: "video",
  usageCommand: "zero built-in generate video",
  examples: `  Generate video:        zero built-in generate video --prompt "A tracking shot through a neon market"
  Pipe prompt:           cat prompt.txt | zero built-in generate video
  Use Kling:             zero built-in generate video --model kling-o3-standard --prompt "A product reveal" --duration 10s
  Use Seedance:          zero built-in generate video --model seedance2.0-fast --prompt "A multi-shot chase scene" --duration 8s --resolution 480p
  Use Veo 3.1:           zero built-in generate video --model veo3.1 --prompt "A cinematic product reveal" --duration 6s --resolution 1080p`,
});
