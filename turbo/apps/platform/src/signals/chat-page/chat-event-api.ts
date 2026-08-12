import {
  chatFeedbackLocationEventsContract,
  chatEventsContract,
  type ChatEventSendBody,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

function projectPreviousApiFeedbackDocument(
  document: UserMessageDocument,
): UserMessageDocument | null {
  let changed = false;
  const parts = document.parts.map((part) => {
    if (
      part.type !== "feedback" ||
      (part.eventId === undefined && part.range === undefined)
    ) {
      return part;
    }
    changed = true;
    const projected = { ...part };
    delete projected.eventId;
    delete projected.range;
    return projected;
  });
  return changed ? { ...document, parts } : null;
}

function projectPreviousApiFeedbackBody(
  body: ChatEventSendBody,
): ChatEventSendBody | null {
  if (body.userMessage === undefined) {
    return null;
  }
  const userMessage = projectPreviousApiFeedbackDocument(body.userMessage);
  return userMessage === null ? null : { ...body, userMessage };
}

export async function sendChatEvent(
  createClient: ZeroClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
) {
  const previousApiBody = projectPreviousApiFeedbackBody(body);
  if (previousApiBody !== null) {
    const result = await accept(
      createClient(chatFeedbackLocationEventsContract).send({
        body,
        fetchOptions: { signal },
      }),
      [201, 404],
      signal,
    );
    if (result.status === 201) {
      return result.body;
    }

    // A browser-resident new App can keep running against a rolled-back API
    // for about two days. The previous API has no versioned location route, so
    // retry its canonical route without eventId/range. Remove this route and
    // retry after the accepting API is outside rollback and stale App clients
    // have expired. Follow-up: #26697.
    const retry = await accept(
      createClient(chatEventsContract).send({
        body: previousApiBody,
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    return retry.body;
  }

  const result = await accept(
    createClient(chatEventsContract).send({
      body,
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
  return result.body;
}
