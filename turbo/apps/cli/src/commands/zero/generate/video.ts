import { createVideoGenerateCommand } from "../shared/video-generate";

export const videoCommand = createVideoGenerateCommand({
  name: "video",
  generationType: "video",
  usageCommand: "okou generate video",
  examples: `  Generate video:        okou generate video --prompt "A tracking shot through a neon market"
  Use a template:        okou generate video --template video-template:epic-grandeur --prompt "A cinematic mountain reveal"
  Pipe prompt:           cat prompt.txt | okou generate video
  Use Dreamina 2.5:      okou generate video --model dreamina-seedance-2.5 --prompt "A 30-second cinematic story" --duration 30s --resolution 720p
  Use Dreamina 2.0:      okou generate video --model dreamina-seedance-2.0 --prompt "A cinematic product reveal" --duration 6s --resolution 1080p
  Use Dreamina Mini:     okou generate video --model dreamina-seedance-2.0-mini --prompt "A cinematic product reveal" --duration 6s --resolution 720p
  Use Seedance 1.5 Pro:  okou generate video --model seedance-1.5-pro --prompt "A multi-shot chase scene" --duration 8s --resolution 720p
  Use MiniMax H3:         okou generate video --model minimax-h3 --prompt "A cinematic product reveal" --duration 5s --resolution 2k
  Add a first frame:     okou generate video --first-frame-image-url https://example.com/frame.png --prompt "Animate this frame"
  List providers:        okou generate video
  Use HeyGen:            okou generate video --provider heygen`,
});
