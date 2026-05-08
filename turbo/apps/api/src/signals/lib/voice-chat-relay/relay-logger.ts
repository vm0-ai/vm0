// Typed logger wrapper for the realtime relay. Restricts the extras object
// to identifier/control fields so transcript text or audio payloads can never
// be logged accidentally — making "log a transcript" a TypeScript error.
//
// The Epic's task 10 acceptance bars require: per-relay log lines must
// include vm0 voice session id + relay session id + org id + user id (and
// openai session id when known); they MUST NOT include raw transcript,
// prompt, or audio payloads.

import { logger } from "../../../lib/log";

const baseLogger = logger("zero:voice-chat:realtime-relay");

export interface RelayLogContext {
  readonly relaySessionId: string;
  readonly voiceChatSessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly openaiSessionId?: string;
}

export interface RelayLogExtras {
  readonly eventType?: string;
  readonly closeCode?: number;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly bytes?: number;
  readonly handlerName?: string;
}

// `info` is intentionally NOT exposed: project lint policy forbids
// logger.info() in API source — debug for routine diagnostics, warn/error
// for actionable issues. Sub-issues plugging into onProviderEvent that
// surface signal-worthy events should pick warn/error explicitly.
export interface RelayLogger {
  debug(message: string, extras?: RelayLogExtras): void;
  warn(message: string, extras?: RelayLogExtras): void;
  error(message: string, extras?: RelayLogExtras): void;
}

function buildFields(
  ctx: RelayLogContext,
  extras: RelayLogExtras | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    relaySessionId: ctx.relaySessionId,
    voiceChatSessionId: ctx.voiceChatSessionId,
    orgId: ctx.orgId,
    userId: ctx.userId,
  };
  if (ctx.openaiSessionId !== undefined) {
    fields["openaiSessionId"] = ctx.openaiSessionId;
  }
  if (extras !== undefined) {
    if (extras.eventType !== undefined) {
      fields["eventType"] = extras.eventType;
    }
    if (extras.closeCode !== undefined) {
      fields["closeCode"] = extras.closeCode;
    }
    if (extras.errorMessage !== undefined) {
      fields["errorMessage"] = extras.errorMessage;
    }
    if (extras.durationMs !== undefined) {
      fields["durationMs"] = extras.durationMs;
    }
    if (extras.bytes !== undefined) {
      fields["bytes"] = extras.bytes;
    }
    if (extras.handlerName !== undefined) {
      fields["handlerName"] = extras.handlerName;
    }
  }
  return fields;
}

export function relayLogger(ctx: RelayLogContext): RelayLogger {
  return {
    debug: (message, extras) => {
      baseLogger.debug(message, buildFields(ctx, extras));
    },
    warn: (message, extras) => {
      baseLogger.warn(message, buildFields(ctx, extras));
    },
    error: (message, extras) => {
      baseLogger.error(message, buildFields(ctx, extras));
    },
  };
}
