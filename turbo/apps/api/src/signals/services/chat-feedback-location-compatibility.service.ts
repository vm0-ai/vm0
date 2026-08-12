import {
  CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
  CLIENT_TYPE_APP,
  clientVersionHasTag,
} from "@vm0/api-contracts/contracts/client-headers";
import type { ChatEventRowV4 } from "@vm0/api-contracts/contracts/chat-event-rows";
import {
  type ChatEvent,
  type UserMessageDocument,
  type UserMessageInputDocument,
  userMessageDocumentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import { computed } from "ccstate";

import { clientType$, clientVersion$ } from "../context/hono";

function needsLegacyFeedbackLocationProjection(args: {
  readonly clientType: string | undefined;
  readonly clientVersion: string | undefined;
}): boolean {
  return (
    args.clientType === CLIENT_TYPE_APP &&
    !clientVersionHasTag(
      args.clientVersion,
      CLIENT_FEEDBACK_LOCATION_VERSION_TAG,
    )
  );
}

// Old App bundles keep running for about two days and their strict v1 feedback
// reader rejects eventId/range. Keep those bundles on the previous document
// shape until the capability-tagged App rollout has exceeded that window, then
// remove this signal and every projection that consumes it. Follow-up: #26697.
export const legacyFeedbackLocationAppClient$ = computed((get) => {
  return needsLegacyFeedbackLocationProjection({
    clientType: get(clientType$),
    clientVersion: get(clientVersion$),
  });
});

function projectLegacyUserMessageDocument(
  document: UserMessageDocument,
): UserMessageDocument {
  return {
    ...document,
    parts: document.parts.map((part) => {
      if (part.type !== "feedback") {
        return part;
      }
      const projected = { ...part };
      delete projected.eventId;
      delete projected.range;
      return projected;
    }),
  };
}

export function projectLegacyUserMessageInputDocument(
  document: UserMessageInputDocument,
): UserMessageInputDocument {
  return {
    ...document,
    parts: document.parts.map((part) => {
      if (part.type !== "feedback") {
        return part;
      }
      const projected = { ...part };
      delete projected.eventId;
      delete projected.range;
      return projected;
    }),
  };
}

export function projectLegacyChatEvent(event: ChatEvent): ChatEvent {
  switch (event.eventType) {
    case "input.prompt":
    case "input.goal":
    case "input.budget":
    case "input.rejected": {
      return {
        ...event,
        userMessage: projectLegacyUserMessageDocument(event.userMessage),
      };
    }
    case "input.automation": {
      return event.userMessage === undefined
        ? event
        : {
            ...event,
            userMessage: projectLegacyUserMessageDocument(event.userMessage),
          };
    }
    default: {
      return event;
    }
  }
}

function projectUnknownUserMessage(value: unknown): unknown {
  const parsed = userMessageDocumentSchema.safeParse(value);
  return parsed.success ? projectLegacyUserMessageDocument(parsed.data) : value;
}

export function projectLegacyChatEventRow(row: ChatEventRowV4): ChatEventRowV4 {
  const userMessage = row.payload?.userMessage;
  if (userMessage === undefined) {
    return row;
  }
  const projected = projectUnknownUserMessage(userMessage);
  if (projected === userMessage) {
    return row;
  }
  return {
    ...row,
    payload: {
      ...row.payload,
      userMessage: projected,
    },
  };
}
