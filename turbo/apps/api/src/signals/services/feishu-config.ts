import { env } from "../../lib/env";

const REQUIRED_SECRETS = [
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_ENCRYPT_KEY",
] as const;
const REQUIRED_VARS = ["FEISHU_APP_ID", "FEISHU_APP_INSTALL_URL"] as const;

export interface FeishuConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
}

export function feishuEnvironmentStatus(): {
  readonly requiredSecrets: string[];
  readonly requiredVars: string[];
  readonly missingSecrets: string[];
  readonly missingVars: string[];
} {
  const values = {
    FEISHU_APP_ID: env("FEISHU_APP_ID"),
    FEISHU_APP_SECRET: env("FEISHU_APP_SECRET"),
    FEISHU_VERIFICATION_TOKEN: env("FEISHU_VERIFICATION_TOKEN"),
    FEISHU_ENCRYPT_KEY: env("FEISHU_ENCRYPT_KEY"),
    FEISHU_APP_INSTALL_URL: env("FEISHU_APP_INSTALL_URL"),
  };
  return {
    requiredSecrets: [...REQUIRED_SECRETS],
    requiredVars: [...REQUIRED_VARS],
    missingSecrets: REQUIRED_SECRETS.filter((name) => {
      return !values[name];
    }),
    missingVars: REQUIRED_VARS.filter((name) => {
      return !values[name];
    }),
  };
}

export function feishuConfig(): FeishuConfig | null {
  const appId = env("FEISHU_APP_ID");
  const appSecret = env("FEISHU_APP_SECRET");
  const verificationToken = env("FEISHU_VERIFICATION_TOKEN");
  const encryptKey = env("FEISHU_ENCRYPT_KEY");
  if (!appId || !appSecret || !verificationToken || !encryptKey) {
    return null;
  }
  return { appId, appSecret, verificationToken, encryptKey };
}

export function feishuInstallUrl(): string | null {
  return env("FEISHU_APP_INSTALL_URL") ?? null;
}
