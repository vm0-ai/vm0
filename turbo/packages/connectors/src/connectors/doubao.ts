import type { ConnectorConfig } from "../connectors";

export const doubao = {
  doubao: {
    label: "Doubao",
    category: "ai-voice-audio",
    generation: ["audio"],
    tags: ["volcengine", "tts", "asr", "speech", "voice-clone", "mandarin"],
    helpText:
      "Connect Volcengine Doubao (豆包语音) for Mandarin-first text-to-speech, speech recognition, and voice cloning",
    authMethods: {
      "api-token": {
        label: "Doubao API Key",
        helpText:
          "1. Sign in to the [Volcengine new speech console](https://console.volcengine.com/speech/new)\n2. Open **设置 → API Key 管理** ([direct link](https://console.volcengine.com/speech/new/setting/apikeys))\n3. Click **创建 API Key**, name it, and copy the UUID value\n4. The key authorises every endpoint under `openspeech.bytedance.com` — TTS, ASR file recognition, voice cloning",
        storage: {
          secrets: ["DOUBAO_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            DOUBAO_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "00000000-0000-0000-0000-000000000000",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DOUBAO_API_KEY: "$secrets.DOUBAO_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
