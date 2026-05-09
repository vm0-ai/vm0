import { createVoiceGenerateCommand } from "../../shared/voice-generate";

export const voiceCommand = createVoiceGenerateCommand({
  name: "voice",
  usageCommand: "zero built-in generate voice",
  examples: `  Generate speech:       zero built-in generate voice --text "Hello from vm0"
  Pipe text:             cat script.txt | zero built-in generate voice
  Pick a voice:          zero built-in generate voice --text "Ship it" --voice cedar`,
});
