import type { ReactElement } from "react";

// ============================================================================
// Email Template Types (discriminated union)
// ============================================================================

interface AgentReplyTemplate {
  template: "agent-reply";
  props: {
    agentName: string;
    output: string;
    logsUrl: string;
    unsubscribeUrl?: string;
  };
}

interface InboundErrorTemplate {
  template: "inbound-error";
  props: { errorMessage: string; unsubscribeUrl?: string };
}

interface ScheduleCompletedTemplate {
  template: "schedule-completed";
  props: {
    agentName: string;
    output: string;
    logsUrl: string;
    unsubscribeUrl?: string;
  };
}

interface ScheduleFailedTemplate {
  template: "schedule-failed";
  props: {
    agentName: string;
    errorMessage: string;
    logsUrl: string;
    unsubscribeUrl?: string;
  };
}

interface DataExportReadyTemplate {
  template: "data-export-ready";
  props: {
    downloadUrl: string;
    expiresAt: string;
    artifactCount: number;
    unsubscribeUrl?: string;
  };
}

export type EmailTemplate =
  | AgentReplyTemplate
  | InboundErrorTemplate
  | ScheduleCompletedTemplate
  | ScheduleFailedTemplate
  | DataExportReadyTemplate;

// ============================================================================
// Post-Send Action Types (discriminated union)
// ============================================================================

interface SaveThreadSessionAction {
  action: "save_thread_session";
  userId: string;
  composeId: string;
  agentSessionId: string;
  replyToToken: string;
  orgId?: string;
}

interface UpdateThreadSessionAction {
  action: "update_thread_session";
  sessionId: string;
  agentSessionId?: string;
}

export type PostSendAction =
  | SaveThreadSessionAction
  | UpdateThreadSessionAction;

// ============================================================================
// Enqueue Options
// ============================================================================

export interface EnqueueEmailOptions {
  from: string;
  to: string | string[];
  subject: string;
  template: EmailTemplate;
  cc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
  threadAction?: PostSendAction;
}

// ============================================================================
// Internal: Direct send options (used by drain worker)
// ============================================================================

export interface SendEmailDirectOptions {
  from: string;
  to: string | string[];
  subject: string;
  react: ReactElement;
  cc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
}
