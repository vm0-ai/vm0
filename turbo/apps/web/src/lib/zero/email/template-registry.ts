import type { ReactElement } from "react";
import type { EmailTemplate } from "./types";
import { AgentReplyEmail } from "./templates/agent-reply";
import { InboundErrorEmail } from "./templates/inbound-error";
import { DataExportReadyEmail } from "./templates/data-export-ready";
import { DeveloperSupportEmail } from "./templates/developer-support";

/**
 * Resolve an EmailTemplate discriminated union to a React element.
 * Used by the outbox drain worker to reconstruct the email body at send time.
 */
export function resolveTemplate(template: EmailTemplate): ReactElement {
  switch (template.template) {
    case "agent-reply":
      return AgentReplyEmail(template.props);
    case "inbound-error":
      return InboundErrorEmail(template.props);
    case "data-export-ready":
      return DataExportReadyEmail(template.props);
    case "developer-support":
      return DeveloperSupportEmail(template.props);
  }
}
