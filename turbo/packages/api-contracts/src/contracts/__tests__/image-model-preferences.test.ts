import { describe, expect, it } from "vitest";

import {
  chatThreadImageModelContract,
  chatThreadsContract,
} from "../chat-threads";
import { userPreferenceChangedPayloadSchema } from "../realtime";
import {
  updateUserModelPreferenceRequestSchema,
  userModelPreferenceResponseSchema,
} from "../user-model-preference";

describe("image model preference contracts", () => {
  it("accepts canonical thread pins and rejects non-selectable transforms", () => {
    expect(
      chatThreadImageModelContract.update.body.safeParse({
        model: "fal-ai/qwen-image",
      }),
    ).toMatchObject({ success: true });
    expect(
      chatThreadImageModelContract.update.body.safeParse({ model: null }),
    ).toMatchObject({ success: true });
    expect(
      chatThreadImageModelContract.update.body.safeParse({ model: "birefnet" }),
    ).toMatchObject({ success: false });
  });

  it("accepts an optional canonical image model when creating a thread", () => {
    expect(
      chatThreadsContract.create.body.safeParse({
        agentId: "agent-id",
        imageModel: "gpt-image-2",
      }),
    ).toMatchObject({ success: true });
    expect(
      chatThreadsContract.create.body.safeParse({
        agentId: "agent-id",
        imageModel: "clarity-upscaler",
      }),
    ).toMatchObject({ success: false });
  });

  it("keeps the member image field optional and nullable on both directions", () => {
    const basePreference = {
      selectedModel: null,
      serviceTier: null,
    };

    expect(
      updateUserModelPreferenceRequestSchema.safeParse(basePreference),
    ).toMatchObject({ success: true });
    expect(
      updateUserModelPreferenceRequestSchema.safeParse({
        ...basePreference,
        selectedImageModel: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      updateUserModelPreferenceRequestSchema.safeParse({
        ...basePreference,
        selectedImageModel: "fal-ai/nano-banana-2",
      }),
    ).toMatchObject({ success: true });
    expect(
      updateUserModelPreferenceRequestSchema.safeParse({
        ...basePreference,
        selectedImageModel: "birefnet",
      }),
    ).toMatchObject({ success: false });

    expect(
      userModelPreferenceResponseSchema.safeParse({
        ...basePreference,
        updatedAt: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      userModelPreferenceResponseSchema.safeParse({
        ...basePreference,
        selectedImageModel: "fal-ai/nano-banana-2",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }),
    ).toMatchObject({ success: true });
  });

  it("recognizes image-default invalidation without rejecting future kinds", () => {
    expect(
      userPreferenceChangedPayloadSchema.parse({
        kinds: ["defaultImageModel", "futurePreferenceKind"],
      }),
    ).toStrictEqual({ kinds: ["defaultImageModel"] });
  });
});
