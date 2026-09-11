import type { MultimodalVoiceInputModelId } from "@okouai/api-contracts/contracts/voice-input-models";
import { z } from "zod";

import { logger } from "../../lib/log";
import { readBoundedResponseText, safeJsonParse } from "../utils";
import { gcpLlmAccessToken, gcpLlmConfiguration } from "./gcp-llm-auth";
import type { VoiceCompletionRequest } from "./voice-completion-types";
import { requestVoiceProvider } from "./voice-provider-request";

const L = logger("VertexVoice");
type VertexVoiceModel = Exclude<
  MultimodalVoiceInputModelId,
  "openai/gpt-audio" | "openai/gpt-audio-mini"
>;
// New public multimodal selections must make an explicit routing decision.
const MODELS = {
  "google/gemini-2.5-flash-lite": {
    model: "gemini-2.5-flash-lite",
    location: "us-west1",
    host: "us-west1-aiplatform.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0,
      maxOutputTokens: 65_535,
    },
  },
  "google/gemini-3.1-flash-lite": {
    model: "gemini-3.1-flash-lite",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      temperature: 0,
      maxOutputTokens: 65_536,
    },
  },
  "google/gemini-3.6-flash": {
    model: "gemini-3.6-flash",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      maxOutputTokens: 65_536,
    },
  },
  "google/gemini-3.8-flash": {
    model: "gemini-3.8-flash",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: 65_536,
    },
  },
} as const satisfies Readonly<Record<VertexVoiceModel, unknown>>;

export function isVertexVoiceModel(
  model: MultimodalVoiceInputModelId,
): model is VertexVoiceModel {
  return Object.hasOwn(MODELS, model);
}

class VertexVoiceError extends Error {
  constructor(readonly status: number) {
    super("Google voice request failed");
    this.name = "VertexVoiceError";
  }
}

const responseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.literal("STOP"),
        content: z.object({
          parts: z.array(
            z.object({ text: z.string(), thought: z.boolean().optional() }),
          ),
        }),
      }),
    )
    .length(1),
});

/** Voice-only native transport; other Google consumers keep their own routing. */
export async function generateVertexVoice<T>(
  args: VoiceCompletionRequest & { readonly model: VertexVoiceModel },
  parseResponse: (content: string) => T,
  signal: AbortSignal,
): Promise<T | null> {
  const configuration = gcpLlmConfiguration();
  if (!configuration) {
    return null;
  }
  const model = MODELS[args.model];
  const parts =
    typeof args.content === "string"
      ? [{ text: args.content }]
      : args.content.map((part) => {
          return part.type === "audio"
            ? { inlineData: { mimeType: "audio/wav", data: part.audio.data } }
            : { text: part.text };
        });
  const schema = args.jsonSchema?.schema;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: args.systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      ...model.generationConfig,
      ...(schema && {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, property]) => {
              return [
                key,
                { type: "STRING", description: property.description },
              ];
            }),
          ),
          required: schema.required,
        },
      }),
    },
  });
  return await requestVoiceProvider(
    async (requestSignal) => {
      const token = await gcpLlmAccessToken(configuration, requestSignal);
      requestSignal.throwIfAborted();
      return await fetch(
        `https://${model.host}/v1/projects/${configuration.project}/locations/${model.location}/publishers/google/models/${model.model}:generateContent`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          signal: requestSignal,
        },
      );
    },
    async (response) => {
      const body = await readBoundedResponseText(
        response,
        args.jsonSchema ? 1024 * 1024 : 2 * 1024 * 1024,
      );
      signal.throwIfAborted();
      if (!response.ok) {
        L.warn("Google voice request rejected", {
          model: args.model,
          location: model.location,
          operation: args.jsonSchema?.name ?? "plain_text_polish",
          status: response.status,
        });
        throw new VertexVoiceError(response.status);
      }
      const parsed = responseSchema.safeParse(
        body.kind === "text" ? safeJsonParse(body.text) : undefined,
      );
      if (!parsed.success || parsed.data.promptFeedback?.blockReason) {
        throw new VertexVoiceError(502);
      }
      const candidate = parsed.data.candidates[0];
      const text = candidate?.content.parts
        .filter((part) => {
          return !part.thought;
        })
        .map((part) => {
          return part.text;
        })
        .join("")
        .trim();
      if (!text) {
        throw new VertexVoiceError(502);
      }
      return parseResponse(text);
    },
    {
      provider: "vertex",
      model: args.model,
      responseSchema: args.jsonSchema?.name,
    },
    signal,
  );
}
