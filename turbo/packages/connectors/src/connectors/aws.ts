import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const aws = {
  aws: {
    label: "AWS",
    category: "data-automation-infrastructure",
    tags: ["cloud", "infrastructure", "storage", "compute"],
    helpText:
      "Connect a temporary AWS session to call AWS APIs with the selected AWS identity.",
    authMethods: {
      cli: {
        featureFlag: FeatureSwitchKey.AwsConnector,
        showExperimentalLabel: false,
        label: "Sign in with AWS",
        helpText:
          "Sign in with AWS and paste the authorization code that AWS displays.\n**This temporary AWS connector expires after up to 12 hours.**",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "arn:aws:signin:::devtools/cross-device",
        },
        storage: {
          secrets: [
            "AWS_LOGIN_REFRESH_TOKEN",
            "AWS_LOGIN_DPOP_KEY",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_SIGNIN_REGION",
            "AWS_REGION",
          ],
          variables: [],
        },
        grant: {
          kind: "external-code",
          scopes: ["openid"],
          outputs: {
            refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
            dpopKey: "$secrets.AWS_LOGIN_DPOP_KEY",
            accessKeyId: "$secrets.AWS_ACCESS_KEY_ID",
            secretAccessKey: "$secrets.AWS_SECRET_ACCESS_KEY",
            sessionToken: "$secrets.AWS_SESSION_TOKEN",
            signinRegion: "$secrets.AWS_SIGNIN_REGION",
            runtimeRegion: "$secrets.AWS_REGION",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
            dpopKey: "$secrets.AWS_LOGIN_DPOP_KEY",
            signinRegion: "$secrets.AWS_SIGNIN_REGION",
          },
          outputs: {
            refreshToken: "$secrets.AWS_LOGIN_REFRESH_TOKEN",
            accessKeyId: "$secrets.AWS_ACCESS_KEY_ID",
            secretAccessKey: "$secrets.AWS_SECRET_ACCESS_KEY",
            sessionToken: "$secrets.AWS_SESSION_TOKEN",
          },
          refreshableSecrets: [
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
          ],
          envBindings: {
            AWS_ACCESS_KEY_ID: "$secrets.AWS_ACCESS_KEY_ID",
            AWS_SECRET_ACCESS_KEY: "$secrets.AWS_SECRET_ACCESS_KEY",
            AWS_SESSION_TOKEN: "$secrets.AWS_SESSION_TOKEN",
            AWS_REGION: "$secrets.AWS_REGION",
            AWS_DEFAULT_REGION: "$secrets.AWS_REGION",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "cli",
  },
} as const satisfies Record<string, ConnectorConfig>;
