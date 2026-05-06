/**
 * Typed state JSON used as the OAuth `state` parameter. Carries
 * orgId + vm0UserId across the connect→callback boundary so the
 * callback can re-check eligibility and persist against the right org.
 */
import { z } from "zod";

const stateSchema = z.object({
  orgId: z.string().min(1),
  vm0UserId: z.string().min(1),
  flow: z.literal("connect"),
});

type ChatgptOAuthState = z.infer<typeof stateSchema>;

export function serializeState(state: ChatgptOAuthState): string {
  return JSON.stringify(state);
}

export function parseState(raw: string | null): ChatgptOAuthState | null {
  if (!raw) return null;
  try {
    return stateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
