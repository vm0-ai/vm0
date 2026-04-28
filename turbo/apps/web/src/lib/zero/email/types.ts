import type { ReactElement } from "react";

// ============================================================================
// Email Template Types (discriminated union)
// ============================================================================

interface AgentReplyTemplate {
  template: "agent-reply";
  props: {
    agentName: string;
    output: string;
    logsUrl?: string;
    unsubscribeUrl?: string;
  };
}

interface InboundErrorTemplate {
  template: "inbound-error";
  props: { errorMessage: string; unsubscribeUrl?: string };
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

interface DeveloperSupportTemplate {
  template: "developer-support";
  props: {
    title: string;
    description: string;
    reference: string;
    userId: string;
    userEmail: string;
    orgId: string;
    orgName: string;
    runId: string;
    downloadUrl: string;
    expiresAt: string;
  };
}

export type EmailTemplate =
  | AgentReplyTemplate
  | InboundErrorTemplate
  | DataExportReadyTemplate
  | DeveloperSupportTemplate;

// ============================================================================
// Post-Send Action Types (discriminated union)
// ============================================================================

interface SaveThreadSessionAction {
  action: "save_thread_session";
  userId: string;
  agentId: string;
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
