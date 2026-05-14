import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "../contracts/model-providers";

export interface RustStringConstantBinding {
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly value: string;
}

const codexOauthPlaceholderNames = [
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
] as const;

type CodexOauthPlaceholderName = (typeof codexOauthPlaceholderNames)[number];

const codexOauthPlaceholderModule = [
  "codex_oauth_token",
  "placeholders",
] as const;

function codexOauthPlaceholder(name: CodexOauthPlaceholderName): string {
  const value =
    MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders?.[name];
  if (value === undefined) {
    throw new Error(
      `codex-oauth-token firewall placeholder is missing ${name}`,
    );
  }
  if (value.length === 0) {
    throw new Error(`codex-oauth-token firewall placeholder ${name} is empty`);
  }
  return value;
}

export const rustStringConstantBindings = codexOauthPlaceholderNames.map(
  (name) => {
    return {
      rustModulePath: codexOauthPlaceholderModule,
      rustConstName: name,
      value: codexOauthPlaceholder(name),
    };
  },
) satisfies readonly RustStringConstantBinding[];
