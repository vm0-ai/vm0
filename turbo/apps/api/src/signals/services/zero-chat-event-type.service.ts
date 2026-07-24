import {
  chatEventTypeSchema,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { zodEnumDriverValueDecoder } from "../../lib/db-structured-result";

interface ChatEventClassifierColumns {
  readonly eventType: AnyPgColumn;
  readonly role: AnyPgColumn;
  readonly content: AnyPgColumn;
  readonly structuredPrompt: AnyPgColumn;
  readonly thinking: AnyPgColumn;
  readonly error: AnyPgColumn;
  readonly runId: AnyPgColumn;
  readonly runLifecycleEvent: AnyPgColumn;
  readonly runEventId: AnyPgColumn;
  readonly goalEvent: AnyPgColumn;
  readonly usagePayload: AnyPgColumn;
  readonly attachFiles: AnyPgColumn;
  readonly attachFileMetadata: AnyPgColumn;
  readonly generationTemplate: AnyPgColumn;
  readonly recommendedFollowups: AnyPgColumn;
  readonly revokesEventId: AnyPgColumn;
  readonly interruptsRunId: AnyPgColumn;
}

function legacyNoInputPayload(columns: ChatEventClassifierColumns): SQL {
  return sql`${isNull(columns.structuredPrompt)}
    AND ${isNull(columns.attachFiles)}
    AND ${isNull(columns.attachFileMetadata)}
    AND ${isNull(columns.generationTemplate)}`;
}

function legacyNoFoldPayload(columns: ChatEventClassifierColumns): SQL {
  return sql`${isNull(columns.thinking)}
    AND ${isNull(columns.runLifecycleEvent)}
    AND ${isNull(columns.goalEvent)}
    AND ${isNull(columns.usagePayload)}
    AND ${isNull(columns.recommendedFollowups)}`;
}

function legacyInputMatches(columns: ChatEventClassifierColumns): SQL {
  const noFoldPayload = legacyNoFoldPayload(columns);
  return sql`
    CASE
      WHEN ${columns.role} = 'user'
        AND ${isNull(columns.error)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noFoldPayload}
        AND NOT (
          ${isNotNull(columns.revokesEventId)}
          AND ${isNull(columns.content)}
          AND ${isNull(columns.structuredPrompt)}
          AND ${isNull(columns.attachFiles)}
          AND ${isNull(columns.attachFileMetadata)}
          AND ${isNull(columns.generationTemplate)}
        )
      THEN 'input.prompt'
    END,
    CASE
      WHEN ${columns.role} = 'user'
        AND ${isNotNull(columns.error)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noFoldPayload}
      THEN 'input.rejected'
    END`;
}

function legacyOutputMatches(columns: ChatEventClassifierColumns): SQL {
  const noInputPayload = legacyNoInputPayload(columns);
  return sql`
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.content)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
        AND ${columns.runEventId} IS DISTINCT FROM 'queue:queued'
        AND ${columns.runEventId} IS DISTINCT FROM 'queue:dequeued'
      THEN 'output.message'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.error)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
        AND ${columns.runEventId} IS DISTINCT FROM 'queue:queued'
        AND ${columns.runEventId} IS DISTINCT FROM 'queue:dequeued'
      THEN 'output.error'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.thinking)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'output.thinking'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.recommendedFollowups)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'output.followups'
    END`;
}

function legacyRunMatches(columns: ChatEventClassifierColumns): SQL {
  const noInputPayload = legacyNoInputPayload(columns);
  const noFoldPayload = legacyNoFoldPayload(columns);
  return sql`
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${columns.runEventId} = 'queue:queued'
        AND ${isNotNull(columns.runId)}
        AND ${isNotNull(columns.content)}
        AND ${isNull(columns.error)}
        AND ${noFoldPayload}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'run.queued'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${columns.runEventId} = 'queue:dequeued'
        AND ${isNotNull(columns.runId)}
        AND ${isNotNull(columns.revokesEventId)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.error)}
        AND ${noFoldPayload}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'run.dequeued'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${columns.runLifecycleEvent} = 'completed'
        AND ${isNotNull(columns.runId)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'run.completed'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${columns.runLifecycleEvent} = 'failed'
        AND ${isNotNull(columns.runId)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'run.failed'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${columns.runLifecycleEvent} = 'cancelled'
        AND ${isNotNull(columns.runId)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'run.cancelled'
    END`;
}

function legacyControlAndFoldMatches(columns: ChatEventClassifierColumns): SQL {
  const noInputPayload = legacyNoInputPayload(columns);
  const noFoldPayload = legacyNoFoldPayload(columns);
  return sql`
    CASE
      WHEN ${columns.role} = 'user'
        AND ${isNotNull(columns.interruptsRunId)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.runId)}
        AND ${isNull(columns.runEventId)}
        AND ${isNull(columns.error)}
        AND ${noFoldPayload}
        AND ${isNull(columns.revokesEventId)}
        AND ${noInputPayload}
      THEN 'control.interrupt'
    END,
    CASE
      WHEN ${columns.role} = 'user'
        AND ${isNotNull(columns.revokesEventId)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.structuredPrompt)}
        AND ${isNull(columns.attachFiles)}
        AND ${isNull(columns.attachFileMetadata)}
        AND ${isNull(columns.generationTemplate)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${isNull(columns.runId)}
        AND ${isNull(columns.runEventId)}
        AND ${noFoldPayload}
      THEN 'control.revoke'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.goalEvent)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.runId)}
        AND ${isNull(columns.runEventId)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.usagePayload)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'goal.changed'
    END,
    CASE
      WHEN ${columns.role} = 'assistant'
        AND ${isNotNull(columns.usagePayload)}
        AND ${isNotNull(columns.runId)}
        AND ${isNull(columns.content)}
        AND ${isNull(columns.runEventId)}
        AND ${isNull(columns.error)}
        AND ${isNull(columns.thinking)}
        AND ${isNull(columns.runLifecycleEvent)}
        AND ${isNull(columns.goalEvent)}
        AND ${isNull(columns.recommendedFollowups)}
        AND ${isNull(columns.revokesEventId)}
        AND ${isNull(columns.interruptsRunId)}
        AND ${noInputPayload}
      THEN 'usage.recorded'
    END`;
}

function legacyChatEventMatches(columns: ChatEventClassifierColumns): SQL {
  return sql`array_remove(ARRAY[
    ${legacyInputMatches(columns)},
    ${legacyOutputMatches(columns)},
    ${legacyRunMatches(columns)},
    ${legacyControlAndFoldMatches(columns)}
  ], NULL)`;
}

/**
 * Read compatibility for rows written by the draining API after the additive
 * migration but before the ChatEvent writer is promoted. Remove after
 * `event_type` is contracted to NOT NULL.
 */
export function chatEventTypeSql(
  columns: ChatEventClassifierColumns = chatMessages,
) {
  const matches = legacyChatEventMatches(columns);
  return sql`COALESCE(
    ${columns.eventType},
    CASE
      WHEN cardinality(${matches}) = 1 THEN (${matches})[1]
      ELSE 'legacy.invalid'
    END
  )`.mapWith(zodEnumDriverValueDecoder(chatEventTypeSchema));
}

export function chatEventTypeIn(
  eventTypes: readonly ChatEventType[],
  columns: ChatEventClassifierColumns = chatMessages,
): SQL {
  return inArray(chatEventTypeSql(columns), [...eventTypes]);
}
