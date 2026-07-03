import { createVoiceGenerateCommand } from "../shared/voice-generate";

export const voiceCommand = createVoiceGenerateCommand({
  name: "voice",
  generationType: "voice",
  usageCommand: "zero generate voice",
  examples: `  Generate speech:       zero generate voice --prompt "Hello from vm0"
  Pipe prompt:           cat script.txt | zero generate voice
  Pick a voice:          zero generate voice --prompt "Ship it" --voice cedar
  List providers:        zero generate voice
  Use ElevenLabs:        zero generate voice --provider elevenlabs`,
});
