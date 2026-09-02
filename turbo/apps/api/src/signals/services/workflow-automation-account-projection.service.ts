import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";

import type { Db } from "../external/db";
import { reprojectGmailAutomationsForOwner } from "./gmail-automation-account.service";
import { reprojectGoogleCalendarAutomationsForOwner } from "./google-calendar-automation-account.service";
import { reprojectGoogleFormsAutomationsForOwner } from "./google-forms-automation-account.service";
import { reprojectGoogleMeetAutomationsForOwner } from "./google-meet-automation-account.service";
import { reprojectNotionAutomationsForOwner } from "./notion-automation-account.service";
import { reprojectStripeInvoicePaidAutomationsForOwner } from "./stripe-invoice-paid-workflow-automation.service";

export async function reprojectWorkflowAutomationsForOwner(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.target.kind !== "builtin") {
    return;
  }
  if (args.target.connectorSlug === "gmail") {
    await reprojectGmailAutomationsForOwner(db, args);
    signal.throwIfAborted();
    return;
  }
  if (args.target.connectorSlug === "google-calendar") {
    await reprojectGoogleCalendarAutomationsForOwner(db, args);
    signal.throwIfAborted();
    return;
  }
  if (args.target.connectorSlug === "notion") {
    await reprojectNotionAutomationsForOwner(db, args);
    signal.throwIfAborted();
    return;
  }
  if (args.target.connectorSlug === "google-forms") {
    await reprojectGoogleFormsAutomationsForOwner(db, args);
    signal.throwIfAborted();
    return;
  }
  if (args.target.connectorSlug === "google-meet") {
    await reprojectGoogleMeetAutomationsForOwner(db, args);
    signal.throwIfAborted();
    return;
  }
  if (args.target.connectorSlug === "stripe") {
    await reprojectStripeInvoicePaidAutomationsForOwner(db, args, signal);
  }
}
