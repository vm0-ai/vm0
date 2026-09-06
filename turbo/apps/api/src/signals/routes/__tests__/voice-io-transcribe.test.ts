import { Buffer } from "node:buffer";

import {
  VOICE_IO_TRANSCRIBE_MAX_FILES,
  voiceIoTranscribeContract,
  type VoiceIoEditorContext,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { userPreferencesRoutes } from "../user-preferences";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { voiceIoTranscribeRoutes } from "../voice-io-transcribe";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const mocks = createRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterRequest {
  readonly model: string;
  readonly reasoning?: {
    readonly effort?: string;
    readonly enabled?: boolean;
  };
  readonly messages: readonly {
    readonly role: string;
    readonly content:
      | string
      | readonly {
          readonly type: string;
          readonly text?: string;
          readonly input_audio?: {
            readonly data: string;
            readonly format: string;
          };
        }[];
  }[];
  readonly response_format: {
    readonly json_schema: { readonly name: string };
  };
}

function client() {
  return setupApp({ context, routes: voiceIoTranscribeRoutes })(
    voiceIoTranscribeContract,
  );
}

function preferencesClient() {
  return setupApp({ context, routes: userPreferencesRoutes })(
    userPreferencesContract,
  );
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function wavBytes(
  marker: number,
  durationSeconds = 1,
): Uint8Array<ArrayBuffer> {
  const sampleRate = 16_000;
  const dataSize = sampleRate * durationSeconds * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataSize, true);
  view.setInt16(44, marker, true);
  return bytes;
}

function audioFile(marker: number, durationSeconds = 1): File {
  return new File(
    [wavBytes(marker, durationSeconds)],
    `voice-${String(marker)}.wav`,
    {
      type: "audio/wav",
    },
  );
}

async function waitForAbort(
  signal: AbortSignal,
  testSignal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  const aborted = createDeferredPromise<void>(testSignal);
  signal.addEventListener(
    "abort",
    () => {
      if (!aborted.settled()) {
        aborted.resolve(undefined);
      }
    },
    { once: true },
  );
  await aborted.promise;
}

function form(
  files: readonly File[],
  reference?: string,
  editorContext?: VoiceIoEditorContext,
): FormData {
  const data = new FormData();
  for (const file of files) {
    data.append("file", file);
  }
  if (reference !== undefined) {
    data.append("lastAssistantMessage", reference);
  }
  if (editorContext !== undefined) {
    data.append("editorContext", JSON.stringify(editorContext));
  }
  return data;
}

async function enabledActor() {
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Voice draft tests require an organization");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 10_000 });
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
    { [FeatureSwitchKey.VoiceInputV2]: true },
  );
  return actor;
}

function requestAudioParts(request: OpenRouterRequest) {
  const userMessage = request.messages[1];
  if (!userMessage || typeof userMessage.content === "string") {
    throw new Error("Expected a multimodal user message");
  }
  return userMessage.content;
}

function rejectDisabledReasoning(request: OpenRouterRequest) {
  if (
    request.reasoning?.effort === "none" ||
    request.reasoning?.enabled === false
  ) {
    return HttpResponse.json(
      {
        error: {
          message:
            "Reasoning is mandatory for this endpoint and cannot be disabled.",
          code: 400,
          metadata: { provider_name: null },
        },
      },
      { status: 400 },
    );
  }
  return undefined;
}

describe("POST /api/voice-io/transcribe", () => {
  it("uses the selected multimodal model for every long-recording chunk and polish", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const headers = { authorization: "Bearer clerk-session" };
    await accept(
      preferencesClient().update({
        headers,
        body: { voiceInputModel: "google/gemini-3.6-flash" },
      }),
      [200],
    );
    const models: string[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as OpenRouterRequest & {
          model: string;
        };
        models.push(body.model);
        const result =
          body.response_format.json_schema.name === "voice_transcript"
            ? { transcript: "Monday", language: "en" }
            : { polishedText: "Monday.", language: "en" };
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(result) },
            },
          ],
        });
      }),
    );
    const response = await accept(
      client().post({
        headers,
        body: form([audioFile(1, 50), audioFile(2, 50)]),
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      transcript: "Monday Monday",
      polishedText: "Monday.",
      language: "en",
    });
    expect(models).toStrictEqual([
      "google/gemini-3.6-flash",
      "google/gemini-3.6-flash",
      "google/gemini-3.6-flash",
    ]);
  });

  it.each(["openai/gpt-audio", "openai/gpt-audio-mini"] as const)(
    "transcribes long audio with %s and uses a text-capable model for polish",
    async (model) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      const actor = await enabledActor();
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.OkouDebug]: true },
      );
      const headers = { authorization: "Bearer clerk-session" };
      await accept(
        preferencesClient().update({
          headers,
          body: { voiceInputModel: model },
        }),
        [200],
      );
      const models: string[] = [];
      server.use(
        http.post(OPENROUTER_URL, async ({ request }) => {
          const body = (await request.json()) as OpenRouterRequest & {
            model: string;
          };
          models.push(body.model);
          const textOnly = typeof body.messages[1]?.content === "string";
          if (textOnly && body.model === model) {
            return HttpResponse.json(
              { error: { message: "An audio modality is required" } },
              { status: 400 },
            );
          }
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify(
                    textOnly
                      ? { polishedText: "Ship Monday.", language: "en" }
                      : { transcript: "Ship Monday", language: "en" },
                  ),
                },
              },
            ],
          });
        }),
      );
      const response = await accept(
        client().post({
          headers,
          body: form([audioFile(1, 50), audioFile(2, 50)]),
        }),
        [200],
      );
      expect(models).toStrictEqual([
        model,
        model,
        "google/gemini-3.1-flash-lite",
      ]);
      expect(response.body).toStrictEqual({
        transcript: "Ship Monday Ship Monday",
        polishedText: "Ship Monday.",
        language: "en",
      });
      expect(response.headers.get("X-Voice-Input-Model")).toBe(model);
      expect(response.headers.get("X-Voice-Polish-Model")).toBe(
        "google/gemini-3.1-flash-lite",
      );
    },
  );

  it("treats a dedicated transcription model's empty result as no speech", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const headers = { authorization: "Bearer clerk-session" };
    await accept(
      preferencesClient().update({
        headers,
        body: { voiceInputModel: "qwen/qwen3-asr-1.7b" },
      }),
      [200],
    );
    server.use(
      http.post("https://openrouter.ai/api/v1/audio/transcriptions", () => {
        return HttpResponse.json({ text: "" });
      }),
    );
    const response = await client().post({
      headers,
      body: form([audioFile(0)]),
    });
    expect(response.status).toBe(204);
  });

  it("reports a selected transcription provider failure without changing models", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const headers = { authorization: "Bearer clerk-session" };
    await accept(
      preferencesClient().update({
        headers,
        body: { voiceInputModel: "fal-ai/elevenlabs/speech-to-text/scribe-v2" },
      }),
      [200],
    );
    server.use(
      http.post(
        "https://fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2",
        () => {
          return new HttpResponse(null, { status: 429 });
        },
      ),
    );
    const response = await accept(
      client().post({ headers, body: form([audioFile(1)]) }),
      [503],
    );
    expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it.each([
    {
      model: "google/gemini-2.5-flash-lite",
      reasoning: "none",
      maxTokens: 65_535,
    },
    {
      model: "google/gemini-3.1-flash-lite",
      reasoning: "minimal",
      maxTokens: 65_536,
    },
    {
      model: "google/gemini-3.6-flash",
      reasoning: "minimal",
      maxTokens: 65_536,
    },
    {
      model: "google/gemini-3.8-flash",
      reasoning: "minimal",
      maxTokens: 65_536,
    },
    { model: "openai/gpt-audio", reasoning: null, maxTokens: 16_384 },
    { model: "openai/gpt-audio-mini", reasoning: null, maxTokens: 16_384 },
  ] as const)(
    "uses the persisted $model preference for a non-staff user",
    async ({ model, reasoning, maxTokens }) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      await enabledActor();
      const headers = { authorization: "Bearer clerk-session" };
      await accept(
        preferencesClient().update({
          headers,
          body: { voiceInputModel: model },
        }),
        [200],
      );
      const saved = await accept(preferencesClient().get({ headers }), [200]);
      expect(saved.body.voiceInputModel).toBe(model);
      let providerRequest: unknown;
      server.use(
        http.post(OPENROUTER_URL, async ({ request }) => {
          providerRequest = await request.json();
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    transcript: "Ship on Monday.",
                    polishedText: "Ship on Monday.",
                    language: "en",
                  }),
                },
              },
            ],
          });
        }),
      );
      const response = await accept(
        client().post({ headers, body: form([audioFile(1)]) }),
        [200],
      );
      expect(response.body.polishedText).toBe("Ship on Monday.");
      expect(providerRequest).toMatchObject({ model, max_tokens: maxTokens });
      if (reasoning) {
        expect(providerRequest).toMatchObject({
          reasoning: { effort: reasoning },
          response_format: { type: "json_schema" },
        });
      } else {
        expect(providerRequest).not.toHaveProperty("reasoning");
        expect(providerRequest).not.toHaveProperty("response_format");
        expect(providerRequest).toMatchObject({ modalities: ["text"] });
      }
      expect(response.headers.get("X-Voice-Input-Model")).toBeNull();
    },
  );

  it.each([
    "qwen/qwen3-asr-flash-2026-02-10",
    "qwen/qwen3-asr-1.7b",
    "qwen/qwen3-asr-0.6b",
    "openai/gpt-transcribe",
    "openai/gpt-4o-transcribe",
    "openai/gpt-4o-mini-transcribe",
    "fal-ai/elevenlabs/speech-to-text/scribe-v2",
  ] as const)(
    "transcribes with %s and applies the shared polish model",
    async (model) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      const actor = await enabledActor();
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      await updateFeatureSwitchesForUser(
        context,
        { userId: actor.userId, orgId: actor.orgId },
        { [FeatureSwitchKey.OkouDebug]: true },
      );
      const headers = { authorization: "Bearer clerk-session" };
      await accept(
        preferencesClient().update({
          headers,
          body: { voiceInputModel: model },
        }),
        [200],
      );
      const elevenLabs = model.startsWith("fal-ai/");
      let transcriptionRequest: unknown;
      let polishRequest: unknown;
      server.use(
        http.post(
          elevenLabs
            ? `https://fal.run/${model}`
            : "https://openrouter.ai/api/v1/audio/transcriptions",
          async ({ request }) => {
            transcriptionRequest = await request.json();
            return HttpResponse.json({ text: "um ship Monday" });
          },
        ),
        http.post(OPENROUTER_URL, async ({ request }) => {
          polishRequest = await request.json();
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    polishedText: "Ship Monday.",
                    language: "en",
                  }),
                },
              },
            ],
          });
        }),
      );
      const response = await accept(
        client().post({ headers, body: form([audioFile(7)]) }),
        [200],
      );
      expect(response.body).toStrictEqual({
        transcript: "um ship Monday",
        polishedText: "Ship Monday.",
        language: "en",
      });
      expect(transcriptionRequest).toMatchObject(
        elevenLabs
          ? {
              audio_url: expect.stringContaining("data:audio/wav;base64,"),
              tag_audio_events: false,
              diarize: false,
            }
          : { model, input_audio: { format: "wav" }, response_format: "json" },
      );
      expect(polishRequest).toMatchObject({
        model: "google/gemini-3.1-flash-lite",
      });
      expect(response.headers.get("X-Voice-Input-Model")).toBe(model);
      expect(response.headers.get("X-Voice-Polish-Model")).toBe(
        "google/gemini-3.1-flash-lite",
      );
      expect(response.headers.get("Server-Timing")).toContain(
        "voice_transcribe;dur=",
      );
      expect(response.headers.get("Server-Timing")).toContain(
        "voice_polish;dur=",
      );
    },
  );

  it("preserves a model through older preference writes, isolates users, and resets to the default", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = await enabledActor();
    const headers = { authorization: "Bearer clerk-session" };
    await accept(
      preferencesClient().update({
        headers,
        body: { voiceInputModel: "google/gemini-3.8-flash" },
      }),
      [200],
    );
    await accept(
      preferencesClient().update({ headers, body: { theme: "dark" } }),
      [200],
    );
    const preserved = await accept(preferencesClient().get({ headers }), [200]);
    expect(preserved.body.voiceInputModel).toBe("google/gemini-3.8-flash");
    const other = createBddApi(context).user({ orgId: actor.orgId });
    mocks.clerk.session(other.userId, other.orgId, "org:member");
    const isolated = await accept(preferencesClient().get({ headers }), [200]);
    expect(isolated.body.voiceInputModel).toBeNull();
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await accept(
      preferencesClient().update({ headers, body: { voiceInputModel: null } }),
      [200],
    );
    const reset = await accept(preferencesClient().get({ headers }), [200]);
    expect(reset.body.voiceInputModel).toBeNull();
    let providerRequest: unknown;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        providerRequest = await request.json();
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  transcript: "Hello.",
                  polishedText: "Hello.",
                  language: "en",
                }),
              },
            },
          ],
        });
      }),
    );
    const response = await accept(
      client().post({ headers, body: form([audioFile(1)]) }),
      [200],
    );
    expect(response.body.polishedText).toBe("Hello.");
    expect(providerRequest).toMatchObject({
      model: "google/gemini-3.1-flash-lite",
    });
  });

  it.each([
    { label: "short recording", durations: [1] },
    { label: "long recording", durations: [30, 30, 30, 30] },
  ])(
    "completes a $label containing no intelligible speech without content",
    async ({ durations }) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      await enabledActor();
      const schemaNames: string[] = [];
      server.use(
        http.post(OPENROUTER_URL, async ({ request }) => {
          const body = (await request.json()) as OpenRouterRequest;
          const schemaName = body.response_format.json_schema.name;
          schemaNames.push(schemaName);
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify(
                    schemaName === "voice_transcript"
                      ? { transcript: "[NO_SPEECH]", language: "und" }
                      : {
                          transcript: "[NO_SPEECH]",
                          polishedText: "[NO_SPEECH]",
                          language: "und",
                        },
                  ),
                },
              },
            ],
          });
        }),
      );

      const response = await accept(
        client().post({
          headers: { authorization: "Bearer clerk-session" },
          body: form(
            durations.map((duration, index) => {
              return audioFile(index + 1, duration);
            }),
          ),
        }),
        [204],
      );

      expect(response.body).toBeUndefined();
      expect(schemaNames).toStrictEqual(
        durations.map(() => {
          return durations.length === 1
            ? "voice_transcript_and_polish"
            : "voice_transcript";
        }),
      );
    },
  );

  it("omits silent chunks before stitching and globally polishing a long recording", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const files = [audioFile(1, 45), audioFile(2, 45), audioFile(3, 45)];
    const transcripts = new Map([
      [Buffer.from(wavBytes(1, 45)).toString("base64"), "First spoken note."],
      [Buffer.from(wavBytes(2, 45)).toString("base64"), "[NO_SPEECH]"],
      [Buffer.from(wavBytes(3, 45)).toString("base64"), "Final spoken note."],
    ]);
    let globalPolishContent = "";
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as OpenRouterRequest;
        const schemaName = body.response_format.json_schema.name;
        let responseBody:
          | { transcript: string; language: string }
          | { polishedText: string; language: string };
        if (schemaName === "polished_voice_transcript") {
          const content = body.messages[1]?.content;
          if (typeof content !== "string") {
            throw new Error("Expected transcript text for global polish");
          }
          globalPolishContent = content;
          responseBody = {
            polishedText: "First spoken note. Final spoken note.",
            language: "en-US",
          };
        } else {
          const data = requestAudioParts(body).at(-1)?.input_audio?.data;
          const transcript = data ? transcripts.get(data) : undefined;
          if (!transcript) {
            throw new Error("Expected a known audio chunk");
          }
          responseBody = {
            transcript,
            language: "en-US",
          };
        }
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(responseBody) },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: form(files),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      transcript: "First spoken note. Final spoken note.",
      polishedText: "First spoken note. Final spoken note.",
      language: "en-US",
    });
    expect(globalPolishContent).toContain(
      "First spoken note. Final spoken note.",
    );
    expect(globalPolishContent).not.toContain("[NO_SPEECH]");
  });

  it("transcribes and polishes a short recording in one multimodal request", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const reference = "The current release is called Project Nebula.";
    const editorContext = {
      before: "Please review Project Nebula\n",
      selected: "the previous scope",
      after: " before shipping version 1.5.",
    };
    let providerRequest: OpenRouterRequest | undefined;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        providerRequest = (await request.json()) as OpenRouterRequest;
        const reasoningError = rejectDisabledReasoning(providerRequest);
        if (reasoningError) {
          return reasoningError;
        }
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  transcript: "um ship the nebula release",
                  polishedText: "Ship the Project Nebula release.",
                  language: "en-US",
                }),
              },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: form([audioFile(1)], reference, editorContext),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      transcript: "um ship the nebula release",
      polishedText: "Ship the Project Nebula release.",
      language: "en-US",
    });
    expect(providerRequest).toMatchObject({
      model: "google/gemini-3.1-flash-lite",
      max_tokens: 65_536,
      reasoning: { effort: "minimal" },
      temperature: 0,
      store: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "voice_transcript_and_polish",
          strict: true,
        },
      },
      messages: [
        {
          role: "system",
          content: expect.stringContaining(
            "You are a transcription engine, not a conversational assistant.",
          ),
        },
        { role: "user" },
      ],
    });
    if (!providerRequest) {
      throw new Error("Expected an OpenRouter request");
    }
    const parts = requestAudioParts(providerRequest);
    expect(
      parts.map((part) => {
        return part.type;
      }),
    ).toStrictEqual(["text", "text", "input_audio"]);
    expect(parts[0]?.text).toContain(reference);
    expect(parts[0]?.text).toContain(
      JSON.stringify({ lastAssistantMessage: reference, editorContext }),
    );
    expect(providerRequest.messages[0]?.content).not.toContain(
      editorContext.before,
    );
    expect(parts[1]?.text).toContain(
      "The audio that follows is the ONLY content to transcribe.",
    );
    expect(parts[2]?.input_audio).toStrictEqual({
      data: Buffer.from(wavBytes(1)).toString("base64"),
      format: "wav",
    });
  });

  it("transcribes long-recording chunks with at most three requests before one global polish", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const files = [
      audioFile(1, 30),
      audioFile(2, 30),
      audioFile(3, 30),
      audioFile(4, 30),
    ];
    const transcriptByAudio = new Map(
      files.map((file, index) => {
        return [
          Buffer.from(wavBytes(index + 1, 30)).toString("base64"),
          `part ${String(index + 1)}`,
        ];
      }),
    );
    let activeTranscriptions = 0;
    let maximumActiveTranscriptions = 0;
    let transcriptionRequests = 0;
    const firstWave = createDeferredPromise<void>(context.signal);
    const firstWaveStarted = createDeferredPromise<void>(context.signal);
    let globalPolishContent = "";
    const chunkReferences: string[] = [];
    const editorContext = {
      before: "Review the plan first: ",
      selected: "",
      after: "\nDo not implement yet.",
    };
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as OpenRouterRequest;
        const schemaName = body.response_format.json_schema.name;
        if (schemaName === "polished_voice_transcript") {
          const userMessage = body.messages[1];
          globalPolishContent =
            typeof userMessage?.content === "string" ? userMessage.content : "";
          return HttpResponse.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    polishedText: "Part 1, part 2, part 3, and part 4.",
                    language: "en-US",
                  }),
                },
              },
            ],
          });
        }

        transcriptionRequests += 1;
        chunkReferences.push(requestAudioParts(body)[0]?.text ?? "");
        activeTranscriptions += 1;
        maximumActiveTranscriptions = Math.max(
          maximumActiveTranscriptions,
          activeTranscriptions,
        );
        if (transcriptionRequests === 3) {
          firstWaveStarted.resolve(undefined);
        }
        await firstWave.promise;
        activeTranscriptions -= 1;
        const audioPart = requestAudioParts(body).at(-1);
        const audioData = audioPart?.input_audio?.data;
        const transcript = audioData
          ? transcriptByAudio.get(audioData)
          : undefined;
        if (!transcript) {
          throw new Error("Expected a known voice chunk");
        }
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({ transcript, language: "en-US" }),
              },
            },
          ],
        });
      }),
    );

    const pendingResponse = client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: form(files, "Use the exact product spelling.", editorContext),
    });
    await firstWaveStarted.promise;
    expect(transcriptionRequests).toBe(3);
    firstWave.resolve(undefined);
    const response = await accept(pendingResponse, [200]);

    expect(response.body).toStrictEqual({
      transcript: "part 1 part 2 part 3 part 4",
      polishedText: "Part 1, part 2, part 3, and part 4.",
      language: "en-US",
    });
    expect(transcriptionRequests).toBe(4);
    expect(maximumActiveTranscriptions).toBe(3);
    expect(globalPolishContent).toContain("part 1 part 2 part 3 part 4");
    for (const reference of [...chunkReferences, globalPolishContent]) {
      expect(reference).toContain(JSON.stringify(editorContext));
    }
  });

  it("uses transcript-only audio processing and one global polish for a long single file", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = await enabledActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId },
      { [FeatureSwitchKey.OkouDebug]: true },
    );
    const schemaNames: string[] = [];
    const models: string[] = [];
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as OpenRouterRequest;
        models.push(body.model);
        const reasoningError = rejectDisabledReasoning(body);
        if (reasoningError) {
          return reasoningError;
        }
        const schemaName = body.response_format.json_schema.name;
        schemaNames.push(schemaName);
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify(
                  schemaName === "voice_transcript"
                    ? { transcript: "um one long note", language: "en-US" }
                    : { polishedText: "One long note.", language: "en-US" },
                ),
              },
            },
          ],
        });
      }),
    );

    const response = await accept(
      client().post({
        headers: { authorization: "Bearer clerk-session" },
        body: form([audioFile(9, 91)]),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      transcript: "um one long note",
      polishedText: "One long note.",
      language: "en-US",
    });
    expect(schemaNames).toStrictEqual([
      "voice_transcript",
      "polished_voice_transcript",
    ]);
    expect(models).toStrictEqual([
      "google/gemini-3.1-flash-lite",
      "google/gemini-3.1-flash-lite",
    ]);
    expect(response.headers.get("X-Voice-Input-Model")).toBe(
      "google/gemini-3.1-flash-lite",
    );
    expect(response.headers.get("X-Voice-Polish-Model")).toBe(
      "google/gemini-3.1-flash-lite",
    );
  });

  it("rejects more files than the five-minute chunk policy can produce", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    let providerRequests = 0;
    server.use(
      http.post(OPENROUTER_URL, () => {
        providerRequests += 1;
        return HttpResponse.error();
      }),
    );
    const files = Array.from(
      { length: VOICE_IO_TRANSCRIBE_MAX_FILES + 1 },
      (_, index) => {
        return audioFile(index + 1);
      },
    );

    const response = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: form(files),
    });

    expect(response.status).toBe(400);
    expect(providerRequests).toBe(0);
  });

  it("aborts active chunk requests and does not start queued chunks after one failure", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    await enabledActor();
    const files = [
      audioFile(1, 30),
      audioFile(2, 30),
      audioFile(3, 30),
      audioFile(4, 30),
    ];
    const firstWaveStarted = createDeferredPromise<void>(context.signal);
    let transcriptionRequests = 0;
    let abortedRequests = 0;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        const body = (await request.json()) as OpenRouterRequest;
        if (body.response_format.json_schema.name !== "voice_transcript") {
          throw new Error("Global polish must not start after a chunk failure");
        }
        transcriptionRequests += 1;
        const requestNumber = transcriptionRequests;
        if (transcriptionRequests === 3) {
          firstWaveStarted.resolve(undefined);
        }
        if (requestNumber === 1) {
          await firstWaveStarted.promise;
          return HttpResponse.json(
            { error: { message: "provider unavailable" } },
            { status: 500 },
          );
        }
        await waitForAbort(request.signal, context.signal);
        abortedRequests += 1;
        return HttpResponse.error();
      }),
    );

    const pendingResponse = client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: form(files),
    });
    await firstWaveStarted.promise;
    const response = await pendingResponse;

    expect(response.status).toBe(503);
    expect(transcriptionRequests).toBe(3);
    expect(abortedRequests).toBe(2);
  });

  it.each([
    { label: "malformed JSON", value: "not valid json" },
    {
      label: "oversized selection",
      value: JSON.stringify({
        before: "",
        selected: "x".repeat(1001),
        after: "",
      }),
    },
  ])(
    "rejects invalid editor context before contacting the provider: $label",
    async ({ value }) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
      await enabledActor();
      const body = form([audioFile(1)]);
      body.append("editorContext", value);
      const response = await client().post({
        headers: { authorization: "Bearer clerk-session" },
        body,
      });
      expect(response.status).toBe(400);
    },
  );

  it("requires the voice draft switch and rejects oversized reference context", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = createBddApi(context).user({
      orgId: createUniqueStaffOrgIdFixture(),
    });
    if (!actor.orgId) {
      throw new Error("Voice draft tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: false },
    );
    const disabled = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: form([audioFile(1)]),
    });
    expect(disabled.status).toBe(403);

    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 10_000 });
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.VoiceInputV2]: true },
    );
    const oversized = await client().post({
      headers: { authorization: "Bearer clerk-session" },
      body: form([audioFile(1)], "x".repeat(8001)),
    });
    expect(oversized.status).toBe(400);
  });
});
