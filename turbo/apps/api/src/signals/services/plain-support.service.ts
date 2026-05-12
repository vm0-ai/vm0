import {
  PlainClient,
  uiComponent,
  type EventComponentInput,
} from "@team-plain/typescript-sdk";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";

const log = logger("service:plain-support");

function getPlainClient(): PlainClient | null {
  const apiKey = optionalEnv("PLAIN_API_KEY");
  if (!apiKey) {
    return null;
  }

  return new PlainClient({ apiKey });
}

interface CreateSupportThreadParams {
  readonly userId: string;
  readonly userEmail: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly runId: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly reference: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
  readonly emailSubjectPrefix: string;
}

export async function createPlainSupportThread(
  params: CreateSupportThreadParams,
): Promise<void> {
  const client = getPlainClient();
  if (!client) {
    log.warn("PLAIN_API_KEY not configured, skipping Plain support thread");
    return;
  }

  const tenantRes = await client.upsertTenant({
    identifier: { externalId: params.orgId },
    name: params.orgName,
    externalId: params.orgId,
  });
  if (tenantRes.error) {
    throw new Error(
      `Plain upsertTenant failed: [${tenantRes.error.type}] ${tenantRes.error.message}`,
    );
  }

  const customerRes = await client.upsertCustomer({
    identifier: { externalId: params.userId },
    onCreate: {
      fullName: params.userEmail,
      email: { email: params.userEmail, isVerified: true },
      externalId: params.userId,
      tenantIdentifiers: [{ externalId: params.orgId }],
    },
    onUpdate: {
      fullName: { value: params.userEmail },
      email: { email: params.userEmail, isVerified: true },
    },
  });
  if (customerRes.error) {
    throw new Error(
      `Plain upsertCustomer failed: [${customerRes.error.type}] ${customerRes.error.message}`,
    );
  }

  const threadRes = await client.createThread({
    customerIdentifier: { externalId: params.userId },
    title: `${params.emailSubjectPrefix} ${params.title}`,
    externalId: params.reference,
    tenantIdentifier: { externalId: params.orgId },
    priority: 2,
  });
  if (threadRes.error) {
    throw new Error(
      `Plain createThread failed: [${threadRes.error.type}] ${threadRes.error.message}`,
    );
  }

  const eventRes = await client.createThreadEvent({
    threadId: threadRes.data.id,
    title: "Diagnostic Report",
    components: buildEventComponents(params),
  });
  if (eventRes.error) {
    throw new Error(
      `Plain createThreadEvent failed: [${eventRes.error.type}] ${eventRes.error.message}`,
    );
  }

  log.debug("Plain support thread created", {
    reference: params.reference,
    threadId: threadRes.data.id,
  });
}

function buildEventComponents(
  params: CreateSupportThreadParams,
): EventComponentInput[] {
  const components: EventComponentInput[] = [];

  if (params.description) {
    components.push(uiComponent.text({ text: params.description }));
    components.push(uiComponent.divider({}));
  }

  components.push(uiComponent.text({ text: "Context", size: "L" }));
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "User", color: "MUTED" })],
      asideContent: [
        uiComponent.text({
          text: `${params.userEmail} (${params.userId})`,
        }),
      ],
    }),
  );
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "Org", color: "MUTED" })],
      asideContent: [
        uiComponent.text({ text: `${params.orgName} (${params.orgId})` }),
      ],
    }),
  );
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "Run ID", color: "MUTED" })],
      asideContent: [uiComponent.text({ text: params.runId })],
    }),
  );

  components.push(uiComponent.divider({}));
  components.push(
    uiComponent.linkButton({
      label: "Download Diagnostic Bundle",
      url: params.downloadUrl,
    }),
  );
  components.push(
    uiComponent.text({
      text: `Download link expires ${params.expiresAt}`,
      color: "MUTED",
      size: "S",
    }),
  );

  return components;
}
