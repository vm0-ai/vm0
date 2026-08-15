import { createVoiceGenerateCommand } from "../shared/voice-generate";

export const voiceCommand = createVoiceGenerateCommand({
  name: "voice",
  generationType: "voice",
  usageCommand: "okou generate voice",
  examples: `  Generate speech:       okou generate voice --prompt "Hello from Okou"
  Pipe prompt:           cat script.txt | okou generate voice
  Pick a voice:          okou generate voice --prompt "Ship it" --voice cedar
  List providers:        okou generate voice
  Use ElevenLabs:        okou generate voice --provider elevenlabs`,
});
