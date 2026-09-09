import { z } from "zod";
import { visiblePiMemoryCitationText } from "./pi-memory-citations";

// Frozen by migration 1094. This is literal historical data, with no Goal
// lifecycle authority. Keep it readable after the Goal schema is removed.
const retiredGoalArchivePattern =
  /^Okou Goal retired\.\nGoal ID: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\nOriginal recorded status: (?:active\nRetirement changed this Goal from active to paused; this does not mark the objective complete\.|(?:paused|blocked|complete)\nThe recorded status is preserved; retirement does not mark the objective complete\.)\n\nFull original objective:\n[\s\S]*$/u;

/** Only use on already-projected text together with retained run provenance. */
export function isRetiredGoalArchiveText(content: string): boolean {
  return retiredGoalArchivePattern.test(content);
}

const retiredGoalArchiveSourceSchema = z.object({
  eventType: z.literal("output.message"),
  runId: z.null(),
  revokesEventId: z.null(),
  contextType: z.null(),
  contextId: z.null(),
  runEventSequenceNumber: z.null(),
  runEventId: z.null(),
  payload: z.object({ content: z.string() }).strict(),
});

const contentPayloadSchema = z
  .object({ content: z.string().optional() })
  .nullable();

/** Both the complete raw provenance and the complete notice are required. */
export function isRetiredGoalArchiveRow(row: unknown): boolean {
  const parsed = retiredGoalArchiveSourceSchema.safeParse(row);
  return (
    parsed.success && isRetiredGoalArchiveText(parsed.data.payload.content)
  );
}

export function visibleChatEventRowContent(row: {
  readonly eventType: string;
  readonly runId: string | null;
  readonly revokesEventId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly runEventSequenceNumber: number | null;
  readonly runEventId: string | null;
  readonly payload: unknown;
}): string | null {
  const content = contentPayloadSchema.parse(row.payload)?.content;
  if (content === undefined) {
    return null;
  }
  // Check the original payload: object decoding can discard unknown keys.
  return isRetiredGoalArchiveRow(row)
    ? content
    : visiblePiMemoryCitationText(content);
}
