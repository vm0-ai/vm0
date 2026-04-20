interface AxiomAgentEvent {
  _time: string;
  runId: string;
  userId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

/**
 * Filter events to only include consecutive sequence numbers starting from `since + 1`.
 * This handles Axiom's eventual consistency where events may become queryable out of order.
 *
 * Example:
 * - Input: events=[seq=1, seq=2, seq=4, seq=5], since=0
 * - Output: [seq=1, seq=2] (truncated at gap before seq=4)
 *
 * @param events - Events sorted by sequenceNumber ascending
 * @param since - The last sequence number already processed
 * @returns Consecutive events starting from since+1
 */
export function filterConsecutiveEvents(
  events: AxiomAgentEvent[],
  since: number,
): AxiomAgentEvent[] {
  const consecutiveEvents: AxiomAgentEvent[] = [];
  let expectedSeq = since + 1;

  for (const event of events) {
    if (event.sequenceNumber === expectedSeq) {
      consecutiveEvents.push(event);
      expectedSeq++;
    } else {
      // Gap detected, stop here
      break;
    }
  }

  return consecutiveEvents;
}

export type { AxiomAgentEvent };
