import { createVoiceGenerateCommand } from "../../shared/voice-generate";

export const voiceCommand = createVoiceGenerateCommand({
  name: "voice",
  usageCommand: "zero official generate voice",
  examples: `  Generate speech:       zero official generate voice --text "Hello from vm0"
  Pipe text:             cat script.txt | zero official generate voice
  Pick a voice:          zero official generate voice --text "Ship it" --voice cedar`,
});
