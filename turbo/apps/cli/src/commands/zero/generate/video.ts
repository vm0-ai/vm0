import { createVideoGenerateCommand } from "../shared/video-generate";

export const videoCommand = createVideoGenerateCommand({
  name: "video",
  generationType: "video",
  usageCommand: "zero generate video",
  examples: `  Generate video:        zero generate video --prompt "A tracking shot through a neon market"
  Pipe prompt:           cat prompt.txt | zero generate video
  Use Dreamina 2.0:      zero generate video --model dreamina-seedance-2.0 --prompt "A cinematic product reveal" --duration 6s --resolution 1080p
  Use Seedance 1.5 Pro:  zero generate video --model seedance-1.5-pro --prompt "A multi-shot chase scene" --duration 8s --resolution 720p
  Add a first frame:     zero generate video --first-frame-image-url https://example.com/frame.png --prompt "Animate this frame"
  List providers:        zero generate video
  Use HeyGen:            zero generate video --provider heygen`,
});
