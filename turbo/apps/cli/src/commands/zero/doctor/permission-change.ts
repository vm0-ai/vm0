import { Command, Option } from "commander";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";
import {
  getConnectorFirewall,
  isFirewallConnectorType,
} from "@vm0/connectors/firewalls";
import { withErrorHandler } from "../../../lib/command";
import { getPlatformOrigin } from "./platform-url";

const DEFAULT_PERMISSION_GRANT_DURATION: UserPermissionGrantExpiresIn = "1h";
const PERMISSION_GRANT_DURATIONS = [
  "1h",
  "24h",
  "7d",
  "always",
] as const satisfies readonly UserPermissionGrantExpiresIn[];

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

type PermissionAction = "enable" | "disable";
function printSensitivePermissionGuidance(
  connectorRef: string,
  permission: string,
  action: PermissionAction,
): void {
  if (action !== "enable") return;

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
      "Only allow this permission below if acting as the user is specifically required.",
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
      "Only allow this permission below if direct sending is specifically required.",
    );
    console.log("");
  }
}

function printPermissionActionMessage(args: {
  readonly action: PermissionAction;
  readonly permission: string;
  readonly label: string;
  readonly url: string;
  readonly duration: UserPermissionGrantExpiresIn | undefined;
}): void {
  const grantAction = args.action === "enable" ? "allow" : "deny";
  console.log(
    `You can ${grantAction} the "${args.permission}" permission for your connector access: [Manage ${args.label} permissions](${args.url})`,
  );
  if (args.duration) {
    console.log(
      `Requested duration: ${args.duration}. Use --duration 1h|24h|7d|always to choose a different grant lifetime.`,
    );
  }
}

async function outputPermissionChangeMessage(
  connectorRef: string,
  permission: string,
  action: PermissionAction,
  duration: UserPermissionGrantExpiresIn | undefined,
): Promise<void> {
  const { label } =
    CONNECTOR_TYPES[connectorRef as keyof typeof CONNECTOR_TYPES];

  const platformOrigin = await getPlatformOrigin();
  const agentId = process.env.ZERO_AGENT_ID;

  const urlParams = new URLSearchParams({
    ref: connectorRef,
    permission,
    action: action === "enable" ? "allow" : "deny",
  });
  if (action === "enable") {
    urlParams.set("expiresIn", duration ?? DEFAULT_PERMISSION_GRANT_DURATION);
  }

  const pagePath = agentId ? `/agents/${agentId}/permissions` : "/agents";
  const url = `${platformOrigin}${pagePath}?${urlParams.toString()}`;

  printSensitivePermissionGuidance(connectorRef, permission, action);
  printPermissionActionMessage({
    action,
    permission,
    label,
    url,
    duration:
      action === "enable"
        ? (duration ?? DEFAULT_PERMISSION_GRANT_DURATION)
        : undefined,
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
      "--duration <duration>",
      "Requested allow duration: 1h, 24h, 7d, or always (default: 1h)",
    ).choices([...PERMISSION_GRANT_DURATIONS]),
  )
  .addOption(
    new Option("--reason <text>", "Brief reason for the permission change"),
  )
  .addHelpText(
    "after",
    `
Examples:
  zero doctor permission-change github --permission contents:read --enable
  zero doctor permission-change github --permission contents:write --enable --duration 24h
  zero doctor permission-change slack --permission chat:write --disable

Notes:
  - Outputs a platform URL for the user to adjust the permission
  - Enable requests default to --duration 1h; use 24h or 7d for longer user-approved work
  - Use --duration always only when the user explicitly asks for persistent access
  - Permission changes update the current user's connector grants`,
  )
  .action(
    withErrorHandler(
      async (
        connectorRef: string,
        opts: {
          permission: string;
          enable?: boolean;
          disable?: boolean;
          duration?: UserPermissionGrantExpiresIn;
          reason?: string;
        },
      ) => {
        if (!opts.enable && !opts.disable) {
          throw new Error("Either --enable or --disable is required");
        }
        if (opts.disable && opts.duration !== undefined) {
          throw new Error("--duration is only supported with --enable");
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
          opts.duration,
        );
      },
    ),
  );
