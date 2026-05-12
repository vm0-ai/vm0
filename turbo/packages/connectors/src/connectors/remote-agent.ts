import { FeatureSwitchKey } from "../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const remoteAgent = {
  "remote-agent": {
    label: "Remote Agent",
    category: "engineering-team-execution",
    environmentMapping: {},
    featureFlag: FeatureSwitchKey.RemoteAgent,
    strictFeatureFlag: true,
    helpText:
      "Run local Codex or Claude Code hosts, then call them from chat with `/remote-agent ${host} prompt`",
    authMethods: {
      api: {
        label: "CLI Host",
        helpText:
          "1. Run `npx -p @vm0/cli vm0 login`\n2. Start a host with `npx -p @vm0/cli vm0 remote-agent start`\n3. Keep the host process running, then return here and click **Connect** once it appears online\n4. Run a connected host from chat with `/remote-agent ${host} prompt`",
        secrets: {},
      },
    },
    defaultAuthMethod: "api",
    tags: ["remote", "local", "host", "codex", "claude code"],
  },
} as const satisfies Record<string, ConnectorConfig>;
