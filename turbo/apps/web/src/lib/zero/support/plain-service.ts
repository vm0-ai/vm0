import "server-only";
import { PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import type { EventComponentInput } from "@team-plain/typescript-sdk";
import { env } from "../../../env";
import { logger } from "../../shared/logger";

const log = logger("service:plain");

let plainClient: PlainClient | undefined;

function getPlainClient(): PlainClient | null {
  const apiKey = env().PLAIN_API_KEY;
  if (!apiKey) return null;
  if (!plainClient) {
    plainClient = new PlainClient({ apiKey });
  }
  return plainClient;
}

interface CreateSupportThreadParams {
  userId: string;
  userEmail: string;
  orgId: string;
  orgName: string;
  runId: string;
  title: string;
  description: string | undefined;
  reference: string;
  downloadUrl: string;
  expiresAt: string;
  emailSubjectPrefix: string;
}

/**
 * Create a Plain.com support thread for a diagnostic bundle submission.
 *
 * Call sequence:
 *  1. upsertTenant   — ensure the org exists in Plain
 *  2. upsertCustomer — ensure the user exists and is linked to the org
 *  3. createThread   — open the support thread
 *  4. createThreadEvent — attach description, metadata, and download link
 *
 * Throws if PLAIN_API_KEY is not configured or any API step returns an error.
 * Unexpected exceptions propagate to the caller.
 */
export async function createPlainSupportThread(
  params: CreateSupportThreadParams,
): Promise<void> {
  const client = getPlainClient();
  if (!client) {
    log.warn("PLAIN_API_KEY not configured, skipping Plain support thread");
    return;
  }

  const {
    userId,
    userEmail,
    orgId,
    orgName,
    runId,
    title,
    description,
    reference,
    downloadUrl,
    expiresAt,
    emailSubjectPrefix,
  } = params;

  // 1. Upsert the tenant (org)
  const tenantRes = await client.upsertTenant({
    identifier: { externalId: orgId },
    name: orgName,
    externalId: orgId,
  });
  if (tenantRes.error) {
    throw new Error(
      `Plain upsertTenant failed: [${tenantRes.error.type}] ${tenantRes.error.message}`,
    );
  }

  // 2. Upsert the customer (user), associated with the tenant
  const customerRes = await client.upsertCustomer({
    identifier: { externalId: userId },
    onCreate: {
      fullName: userEmail,
      email: { email: userEmail, isVerified: true },
      externalId: userId,
      tenantIdentifiers: [{ externalId: orgId }],
    },
    onUpdate: {
      fullName: { value: userEmail },
      email: { email: userEmail, isVerified: true },
    },
  });
  if (customerRes.error) {
    throw new Error(
      `Plain upsertCustomer failed: [${customerRes.error.type}] ${customerRes.error.message}`,
    );
  }

  // 3. Create the thread
  const threadRes = await client.createThread({
    customerIdentifier: { externalId: userId },
    title: `${emailSubjectPrefix} ${title}`,
    externalId: reference,
    tenantIdentifier: { externalId: orgId },
    priority: 2,
  });
  if (threadRes.error) {
    throw new Error(
      `Plain createThread failed: [${threadRes.error.type}] ${threadRes.error.message}`,
    );
  }

  const threadId = threadRes.data.id;

  // 4. Add description, metadata, and download link as a thread event
  const eventRes = await client.createThreadEvent({
    threadId,
    title: "Diagnostic Report",
    components: buildEventComponents({
      description,
      userEmail,
      userId,
      orgName,
      orgId,
      runId,
      downloadUrl,
      expiresAt,
    }),
  });
  if (eventRes.error) {
    throw new Error(
      `Plain createThreadEvent failed: [${eventRes.error.type}] ${eventRes.error.message}`,
    );
  }

  log.info("Plain support thread created", { reference, threadId });
}

function buildEventComponents(p: {
  description: string | undefined;
  userEmail: string;
  userId: string;
  orgName: string;
  orgId: string;
  runId: string;
  downloadUrl: string;
  expiresAt: string;
}): EventComponentInput[] {
  const components: EventComponentInput[] = [];

  if (p.description) {
    components.push(uiComponent.text({ text: p.description }));
    components.push(uiComponent.divider({}));
  }

  components.push(uiComponent.text({ text: "Context", size: "L" }));
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "User", color: "MUTED" })],
      asideContent: [
        uiComponent.text({ text: `${p.userEmail} (${p.userId})` }),
      ],
    }),
  );
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "Org", color: "MUTED" })],
      asideContent: [uiComponent.text({ text: `${p.orgName} (${p.orgId})` })],
    }),
  );
  components.push(
    uiComponent.row({
      mainContent: [uiComponent.text({ text: "Run ID", color: "MUTED" })],
      asideContent: [uiComponent.text({ text: p.runId })],
    }),
  );

  components.push(uiComponent.divider({}));
  components.push(
    uiComponent.linkButton({
      label: "Download Diagnostic Bundle",
      url: p.downloadUrl,
    }),
  );
  components.push(
    uiComponent.text({
      text: `Download link expires ${p.expiresAt}`,
      color: "MUTED",
      size: "S",
    }),
  );

  return components;
}
