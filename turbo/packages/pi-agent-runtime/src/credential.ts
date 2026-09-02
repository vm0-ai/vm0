import type {
  PiAgentCredentialHeaderTemplate,
  PiAgentCredentialTarget,
  PiAgentRequestHeaders,
} from "./types";

const CREDENTIAL_PLACEHOLDER = "{{secret}}";
const UNUSED_OPENAI_API_KEY = "unused";
const HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

function resolvedCredentialHeaderValue(args: {
  readonly credential: string;
  readonly header: PiAgentCredentialHeaderTemplate;
  readonly target: PiAgentCredentialTarget;
}): string {
  const staticTemplate = args.header.valueTemplate.replace(
    CREDENTIAL_PLACEHOLDER,
    "",
  );
  if (
    !HEADER_NAME_PATTERN.test(args.header.name) ||
    args.header.valueTemplate.includes("\r") ||
    args.header.valueTemplate.includes("\n") ||
    args.header.valueTemplate.split(CREDENTIAL_PLACEHOLDER).length !== 2 ||
    staticTemplate.includes("{{") ||
    staticTemplate.includes("}}")
  ) {
    throw new Error("Pi credential header policy is invalid");
  }
  return args.target === "sandbox-firewall"
    ? args.credential
    : args.header.valueTemplate.replace(
        CREDENTIAL_PLACEHOLDER,
        args.credential,
      );
}

/**
 * Resolve one credential at the execution edge. Custom gateway secrets travel
 * only in their configured header; the OpenAI SDK receives a non-secret dummy
 * key so it cannot copy the gateway credential into Authorization implicitly.
 */
export function resolvePiAgentCredential(args: {
  readonly credential: string;
  readonly header?: PiAgentCredentialHeaderTemplate;
  readonly target: PiAgentCredentialTarget;
}): {
  readonly apiKey: string;
  readonly requestHeaders?: PiAgentRequestHeaders;
} {
  if (!args.credential.trim()) {
    throw new Error("Pi model credential is unavailable");
  }
  if (!args.header) {
    return { apiKey: args.credential };
  }
  const requestHeaders: PiAgentRequestHeaders = {
    ...(args.header.name.toLowerCase() === "authorization"
      ? {}
      : { authorization: null }),
    [args.header.name]: resolvedCredentialHeaderValue({
      credential: args.credential,
      header: args.header,
      target: args.target,
    }),
  };
  return { apiKey: UNUSED_OPENAI_API_KEY, requestHeaders };
}
