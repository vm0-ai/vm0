import { FeatureSwitchKey } from "../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const localAgent = {
  "local-agent": {
    label: "Local Agent",
    category: "engineering-team-execution",
    helpText:
      "Run local Codex or Claude Code hosts, then call them from chat with `/local-agent ${host} prompt`",
    authMethods: {
      api: {
        featureFlag: FeatureSwitchKey.LocalAgentConnector,
        label: "CLI Host",
        helpText:
          "1. Run `npx -p @vm0/cli vm0 login`\n2. Start a host with `npx -p @vm0/cli vm0 local-agent start`\n3. Keep the host process running, then return here and click **Connect** once it appears online\n4. Run a connected host from chat with `/local-agent ${host} prompt`",
        grant: { kind: "managed" },
        access: { kind: "none" },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api",
    tags: ["remote", "local", "host", "codex", "claude code"],
  },
} as const satisfies Record<string, ConnectorConfig>;
