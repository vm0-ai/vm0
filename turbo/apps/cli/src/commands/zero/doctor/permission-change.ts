import { Command, Option } from "commander";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { withErrorHandler } from "../../../lib/command";
import { resolvePermissionChangeContext } from "./permission-context";
import { getPlatformOrigin } from "./platform-url";

function findPermissionInConfig(ref: string, permissionName: string): boolean {
  if (!isFirewallConnectorType(ref)) return false;
  const config = getConnectorFirewall(ref);
  for (const api of config.apis) {
    if (!api.permissions) continue;
    for (const p of api.permissions) {
      if (p.name === permissionName) return true;
    }
  }
  return false;
}

// Keep legacy approval request reasons short enough for permission-page URLs.
const REASON_MAX_LENGTH = 500;
type PermissionAction = "enable" | "disable";
type PermissionChangeRole = Awaited<
  ReturnType<typeof resolvePermissionChangeContext>
>["role"];

function addReasonParam(
  urlParams: URLSearchParams,
  role: PermissionChangeRole,
  usesUserGrants: boolean,
  reason?: string,
): void {
  if (usesUserGrants || role !== "member" || !reason) return;

  const truncated =
    reason.length > REASON_MAX_LENGTH
      ? reason.slice(0, REASON_MAX_LENGTH)
      : reason;
  urlParams.set("reason", truncated);
}

function printSensitivePermissionGuidance(
  connectorRef: string,
  permission: string,
  action: PermissionAction,
  usesUserGrants: boolean,
): void {
  if (action !== "enable") return;

  const approvalWording = usesUserGrants
    ? "Only allow this permission below"
    : "Only request user approval below";

  // Slack chat:write: strongly recommend bot-based messaging over user identity
  if (connectorRef === "slack" && permission === "chat:write") {
    console.log("");
    console.log(
      "IMPORTANT: Granting chat:write allows sending messages AS THE USER's identity, not as a bot.",
    );
    console.log(
      "Use `zero slack message send -c <channel> -t <text>` to send messages as the bot instead — this is the recommended approach for most use cases.",
    );
    console.log(
      `${approvalWording} if acting as the user is specifically required.`,
    );
    console.log("");
  }

  // Gmail gmail.send: strongly recommend draft-based workflow over direct send
  if (connectorRef === "gmail" && permission === "gmail.send") {
    console.log("");
    console.log(
      "IMPORTANT: Granting gmail.send allows the agent to send emails directly as the user.",
    );
    console.log(
      "Consider keeping gmail.send disabled and using gmail.compose instead — the agent can create drafts for the user to review and send manually.",
    );
    console.log(
      `${approvalWording} if direct sending is specifically required.`,
    );
    console.log("");
  }
}

function printPermissionActionMessage(args: {
  readonly usesUserGrants: boolean;
  readonly action: PermissionAction;
  readonly role: PermissionChangeRole;
  readonly permission: string;
  readonly label: string;
  readonly url: string;
  readonly reason?: string;
}): void {
  if (args.usesUserGrants) {
    const grantAction = args.action === "enable" ? "allow" : "deny";
    console.log(
      `You can ${grantAction} the "${args.permission}" permission for your connector access: [Manage ${args.label} permissions](${args.url})`,
    );
    return;
  }

  if (args.role === "admin" || args.role === "owner") {
    console.log(
      `You can ${args.action} the "${args.permission}" permission directly: [Manage ${args.label} permissions](${args.url})`,
    );
    return;
  }

  if (args.role !== "member") {
    console.log(
      `To ${args.action} the "${args.permission}" permission for ${args.label}: [Manage ${args.label} permissions](${args.url})`,
    );
    return;
  }

  if (!args.reason) {
    console.log(
      `IMPORTANT: Re-run with \`--reason "one sentence why this is needed"\` so the admin can review your request faster.`,
    );
    return;
  }

  if (args.action === "enable") {
    console.log(
      `Permission changes require admin approval. Request access at: [Request ${args.label} access](${args.url})`,
    );
    return;
  }

  console.log(
    `Permission changes require admin approval. Contact an org admin to disable this permission: [View ${args.label} permissions](${args.url})`,
  );
}

async function outputPermissionChangeMessage(
  connectorRef: string,
  permission: string,
  action: PermissionAction,
  reason?: string,
): Promise<void> {
  const { label } =
    CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];

  const platformOrigin = await getPlatformOrigin();
  const agentId = process.env.ZERO_AGENT_ID;
  const context = await resolvePermissionChangeContext(agentId || undefined);
  const role = context.role;
  const permissionGrantMode = context.permissionGrantMode;
  const usesUserGrants = permissionGrantMode === "user-grants";

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: action === "enable" ? "allow" : "deny",
  });
  addReasonParam(urlParams, role, usesUserGrants, reason);

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  printSensitivePermissionGuidance(
    connectorRef,
    permission,
    action,
    usesUserGrants,
  );
  printPermissionActionMessage({
    usesUserGrants,
    action,
    role,
    permission,
    label,
    url,
    reason,
  });
}

export const permissionChangeCommand = new Command()
  .name("permission-change")
  .description("Change or request a permission (enable or disable)")
  .argument("<connector-ref>", "The connector type (e.g. github)")
  .addOption(
    new Option(
      "--permission <name>",
      "The permission name to change",
    ).makeOptionMandatory(),
  )
  .addOption(
    new Option(
      "--enable",
      "Enable or request enabling the permission",
    ).conflicts("disable"),
  )
  .addOption(
    new Option(
      "--disable",
      "Disable or request disabling the permission",
    ).conflicts("enable"),
  )
  .addOption(
    new Option(
      "--reason <text>",
      "Brief reason for admin approval requests (max 500 chars)",
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor permission-change github --permission contents:read --enable
  zero doctor permission-change slack --permission chat:write --disable

Notes:
  - Outputs a platform URL for the user to adjust the permission
  - Depending on rollout state, members either request approval or manage their own permission grants`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          enable?: boolean;
          disable?: boolean;
          reason?: string;
        },
      ) => {
        if (!opts.enable && !opts.disable) {
          throw new Error("Either --enable or --disable is required");
        }

        if (!isFirewallConnectorType(connectorRef)) {
          throw new Error(`Unknown connector type: ${connectorRef}`);
        }

        if (!findPermissionInConfig(connectorRef, opts.permission)) {
          throw new Error(
            `Unknown permission "${opts.permission}" for ${connectorRef}`,
          );
        }

        const action = opts.enable ? "enable" : "disable";
        await outputPermissionChangeMessage(
          connectorRef,
          opts.permission,
          action,
          opts.reason,
        );
      },
    ),
  );
