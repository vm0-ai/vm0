import { z } from "zod";
import {
  introVideoAvatarSchema,
  introVideoStyleSchema,
  introVideoVoiceSchema,
} from "./intro-video-presenter";

export const explainerVideoOptionsSchema = z.object({
  style: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("auto") }),
    z.object({ kind: z.literal("catalog"), style: introVideoStyleSchema }),
  ]),
  avatar: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("catalog"), avatar: introVideoAvatarSchema }),
  ]),
  voice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("default") }),
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("catalog"), voice: introVideoVoiceSchema }),
  ]),
});

export type ExplainerVideoOptions = z.infer<typeof explainerVideoOptionsSchema>;
