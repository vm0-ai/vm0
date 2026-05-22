import { createVideoGenerateCommand } from "../../shared/video-generate";

export const videoCommand = createVideoGenerateCommand({
  name: "video",
  usageCommand: "zero built-in generate video",
  examples: `  Generate video:        zero built-in generate video --prompt "A tracking shot through a neon market"
  Pipe prompt:           cat prompt.txt | zero built-in generate video
  Use Dreamina 2.0:      zero built-in generate video --model dreamina-seedance-2.0 --prompt "A cinematic product reveal" --duration 6s --resolution 1080p
  Use Seedance 1.5 Pro:  zero built-in generate video --model seedance-1.5-pro --prompt "A multi-shot chase scene" --duration 8s --resolution 720p
  Add a first frame:     zero built-in generate video --first-frame-image-url https://example.com/frame.png --prompt "Animate this frame"`,
});
