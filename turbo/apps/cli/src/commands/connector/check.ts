import { Command, Option } from "commander";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  ConnectorCheckDiagnosticResult,
  ConnectorCheckPolicy,
  ConnectorCheckRequest,
} from "@okouai/api-contracts/contracts/connector-check";

import { getApiUrl } from "../../lib/api/config";
import {
  diagnoseConnectorCheck,
  getConnector,
} from "../../lib/api/domains/connectors";
import { getAgentUserConnectors } from "../../lib/api/domains/agents";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { getOkouAgentId } from "../../lib/okou-env";
import { toPlatformUrl } from "../doctor/platform-url";
import {
  isComputerUsePermissionTarget,
  printComputerUsePermissionGuidance,
} from "./computer-use-guidance";
import {
  CALLBACK_PROMPT_PLACEHOLDER,
  connectorActionUrl,
  currentChatSupportsActionCallback,
  printCallbackActionUrlExample,
} from "./action-url";
import {
  isRunBoundConnectorContext,
  resolveRunConnectorAccountLookups,
  runConnectorAccountUnavailableMessage,
  type RunConnectorAccountLookup,
} from "./run-account-context";

interface CheckConnectorOptions {
  readonly connector?: string;
  readonly envName?: string;
  readonly url?: string;
  readonly method: string;
  readonly checkPermission?: string;
}

type ValidatedCheckConnectorOptions = CheckConnectorOptions &
  (
    | { readonly url: string }
    | { readonly url?: undefined; readonly envName: string }
  );

export type ResolvedDiagnostic = Extract<
  ConnectorCheckDiagnosticResult,
  { readonly outcome: "resolved" }
>;
type ResolvedUrlDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "url" }
>;
type ResolvedEnvironmentDiagnostic = Extract<
  ResolvedDiagnostic,
  { readonly mode: "environment" }
>;
type UrlDiagnosticRequest = Extract<
  ConnectorCheckRequest,
  { readonly mode: "url" }
>;

interface DiagContext {
  readonly environmentNames: readonly string[] | null;
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly connectorAvailable: boolean;
  readonly credentialResolution: "network-boundary" | "none";
  readonly run: ResolvedDiagnostic["run"];
  readonly platformOrigin: string;
  readonly agentId: string | undefined;
  readonly runBound: boolean;
}

interface ConnectorConfigurationStatus {
  readonly isConnected: boolean;
  readonly isExpired: boolean;
  readonly runAccount: RunConnectorAccountLookup | null;
}

function stripUrlQueryAndFragment(url: string): string {
  const queryIndex = url.indexOf("?");
  const fragmentIndex = url.indexOf("#");
  let end = url.length;
  if (queryIndex !== -1) end = Math.min(end, queryIndex);
  if (fragmentIndex !== -1) end = Math.min(end, fragmentIndex);
  return url.slice(0, end);
}

function rawUrlAuthorityHasUserinfo(url: string): boolean {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd === -1) return false;

  const authorityStart = schemeEnd + 3;
  let authorityEnd = url.length;
  for (const delimiter of ["/", "?", "#"]) {
    const delimiterIndex = url.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1) {
      authorityEnd = Math.min(authorityEnd, delimiterIndex);
    }
  }
  return url.slice(authorityStart, authorityEnd).includes("@");
}

function shellQuoteArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function connectorSelectionCommand(
  url: string,
  method: string,
  connectorSlug: string,
): string {
  const args = [
    `--url ${shellQuoteArg(url)}`,
    `--connector ${shellQuoteArg(connectorSlug)}`,
  ];
  if (method !== "GET") {
    args.push(`--method ${shellQuoteArg(method)}`);
  }
  return `okou connector check ${args.join(" ")}`;
}

function rawPathFromUrl(url: string): string | undefined {
  const sanitizedUrl = stripUrlQueryAndFragment(url);
  const schemeEnd = sanitizedUrl.indexOf("://");
  if (schemeEnd === -1) return undefined;

  const pathStart = sanitizedUrl.indexOf("/", schemeEnd + 3);
  return pathStart === -1 ? "/" : sanitizedUrl.slice(pathStart);
}

function isComputerUseCheckTarget(opts: CheckConnectorOptions): boolean {
  return isComputerUsePermissionTarget({
    connectorSlug: opts.connector ?? "",
    path: opts.url === undefined ? undefined : rawPathFromUrl(opts.url),
    permission: opts.checkPermission,
  });
}

function validateCheckConnectorOptions(
  opts: CheckConnectorOptions,
  command: Command,
): asserts opts is ValidatedCheckConnectorOptions {
  const hasUrl = opts.url !== undefined;
  // Reject embedded credentials before the diagnostic request leaves the client.
  if (opts.url !== undefined && rawUrlAuthorityHasUserinfo(opts.url)) {
    throw unsafeInputError("invalid-url");
  }
  if (opts.connector !== undefined && !hasUrl) {
    throw new Error(
      "--connector can only be used with --url. Add --url <URL> or remove --connector.",
    );
  }
  if (opts.checkPermission !== undefined && hasUrl) {
    throw new Error(
      "--check-permission cannot be used with --url because the permission is derived from the request. Remove --check-permission.",
    );
  }
  if (opts.checkPermission?.trim() === "") {
    throw new Error("--check-permission requires a non-empty permission name.");
  }
  if (!hasUrl && command.getOptionValueSource("method") === "cli") {
    throw new Error(
      "--method can only be used with --url. Add --url <URL> or remove --method.",
    );
  }
  if (opts.envName === undefined && !hasUrl) {
    throw new Error(
      "Either --env-name or --url is required. Use --help for usage.",
    );
  }
}

export function buildConnectorUrlDiagnosticRequest(args: {
  readonly url: string;
  readonly method: string;
  readonly connectorSlug?: string;
  readonly environmentName?: string;
}): UrlDiagnosticRequest {
  if (rawUrlAuthorityHasUserinfo(args.url)) {
    throw unsafeInputError("invalid-url");
  }
  return {
    mode: "url",
    method: args.method.toUpperCase(),
    url: stripUrlQueryAndFragment(args.url),
    ...(args.connectorSlug !== undefined
      ? { connectorSlug: args.connectorSlug }
      : {}),
    ...(args.environmentName !== undefined
      ? { environmentName: args.environmentName }
      : {}),
  };
}

function buildDiagnosticRequest(
  opts: ValidatedCheckConnectorOptions,
  method: string,
): ConnectorCheckRequest {
  if (opts.url !== undefined) {
    return buildConnectorUrlDiagnosticRequest({
      method,
      url: opts.url,
      connectorSlug: opts.connector,
      environmentName: opts.envName,
    });
  }

  return {
    mode: "environment",
    environmentName: opts.envName,
    ...(opts.checkPermission !== undefined
      ? { permission: opts.checkPermission }
      : {}),
  };
}

function requireUrlRequest(
  request: ConnectorCheckRequest,
): UrlDiagnosticRequest {
  if (request.mode !== "url") {
    throw new Error(
      "Connector diagnostic returned a URL-only outcome for an environment request.",
    );
  }
  return request;
}

function requestedEnvironmentName(request: ConnectorCheckRequest): string {
  if (request.environmentName === undefined) {
    throw new Error(
      "Connector diagnostic returned an environment outcome without an environment name.",
    );
  }
  return request.environmentName;
}

function unsafeInputError(
  reason: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "unsafe-input" }
  >["reason"],
): Error {
  switch (reason) {
    case "invalid-method":
      return new Error(
        "connector check requires --method to be a supported HTTP method.",
      );
    case "invalid-url":
      return new Error(
        "connector check requires --url to be a valid absolute http or https URL.",
      );
    case "unsafe-path":
      return new Error(
        "connector check cannot diagnose unsafe URL paths because they are blocked before permission policy evaluation.",
      );
  }
}

function ambiguousConnectorError(
  request: UrlDiagnosticRequest,
  result: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "ambiguous" }
  >,
): Error {
  const candidates = [...result.candidates].sort((left, right) => {
    return left.connectorSlug.localeCompare(right.connectorSlug);
  });
  const commands = candidates.map((candidate) => {
    return `  ${connectorSelectionCommand(request.url, request.method, candidate.connectorSlug)}`;
  });
  return new Error(
    `Multiple connectors match ${request.method} ${request.url}: ${candidates
      .map((candidate) => {
        return candidate.connectorSlug;
      })
      .join(", ")}\nSelect one explicitly:\n${commands.join("\n")}`,
  );
}

function unknownConnectorError(request: ConnectorCheckRequest): Error {
  if (request.mode === "url" && request.connectorSlug !== undefined) {
    return new Error(
      `Unknown connector slug: ${request.connectorSlug}\nRun: okou connector search ${shellQuoteArg(request.connectorSlug)}`,
    );
  }
  return new Error("The requested connector is unknown.");
}

function noMatchError(
  result: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "no-match" }
  >,
): Error {
  return new Error(
    result.scope === "run"
      ? "No connector found for provided URL — no connector configured for the current run matches this URL"
      : "No connector found for provided URL — no registered connector base URL matches this URL",
  );
}

function connectorMismatchError(
  request: UrlDiagnosticRequest,
  result: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "connector-mismatch" }
  >,
): Error {
  const requestedSlug = request.connectorSlug ?? "the requested connector";
  return new Error(
    `Connector ${requestedSlug} does not own ${request.method} ${request.url}; the matching connector is ${result.connector.connectorSlug}\nRun: ${connectorSelectionCommand(request.url, request.method, result.connector.connectorSlug)}`,
  );
}

function environmentNotOwnedError(
  request: ConnectorCheckRequest,
  result: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "environment-not-owned" }
  >,
): Error {
  const environmentName = requestedEnvironmentName(request);
  return new Error(
    `${environmentName} is not an environment name for the ${result.connector.label} connector. Remove --env-name to use the matched route metadata.`,
  );
}

function environmentNotUsedError(
  request: ConnectorCheckRequest,
  result: Extract<
    ConnectorCheckDiagnosticResult,
    { readonly outcome: "environment-not-used" }
  >,
): Error {
  const environmentName = requestedEnvironmentName(request);
  return new Error(
    `${environmentName} is not used by the matched API route. Expected one of: ${result.environmentNames.join(", ") || "none"}. Remove --env-name to use the matched route metadata.`,
  );
}

export function resolveConnectorCheckDiagnostic(
  request: ConnectorCheckRequest,
  result: ConnectorCheckDiagnosticResult,
): ResolvedDiagnostic {
  switch (result.outcome) {
    case "resolved":
      return result;
    case "unsafe-input":
      throw unsafeInputError(result.reason);
    case "unknown-connector":
      throw unknownConnectorError(request);
    case "unknown-environment":
      throw new Error(
        `Unknown environment name: ${requestedEnvironmentName(request)} — not managed by any connector`,
      );
    case "no-match":
      throw noMatchError(result);
    case "ambiguous":
      throw ambiguousConnectorError(requireUrlRequest(request), result);
    case "connector-mismatch":
      throw connectorMismatchError(requireUrlRequest(request), result);
    case "environment-not-owned":
      throw environmentNotOwnedError(request, result);
    case "environment-not-used":
      throw environmentNotUsedError(request, result);
    case "unresolved-dynamic-base":
      throw new Error(
        `No authoritative ${result.connector.label} base URL is available for this diagnostic. Verify the ${result.connector.connectorSlug} connector configuration for the affected context and retry.`,
      );
    case "run-context-unavailable":
      throw new Error(
        "The current run context is unavailable for connector diagnosis. Retry from an active run or start a new run.",
      );
  }
}

function printDiagnosticSummary(
  request: ConnectorCheckRequest,
  result: ResolvedDiagnostic,
): void {
  if (result.mode === "url") {
    const urlRequest = requireUrlRequest(request);
    console.log(
      `URL ${urlRequest.url} matches the ${result.connector.label} connector (slug: ${result.connector.connectorSlug}).`,
    );
    console.log(`  Matched base URL: ${result.base}`);
    console.log(`  Relative path:    ${result.relativePath}`);
    if (result.environmentNames === null) {
      console.log("  Environment names: unavailable");
    } else {
      console.log(
        `  Environment names: [${result.environmentNames.join(", ")}]`,
      );
    }
    return;
  }

  console.log(
    `${result.environmentName} is managed by the ${result.connector.label} connector (slug: ${result.connector.connectorSlug}).`,
  );
}

function diagnosticEnvironmentNames(
  result: ResolvedDiagnostic,
): readonly string[] | null {
  return result.mode === "url"
    ? result.environmentNames
    : [result.environmentName];
}

function printConnectorConnectionStatus(
  ctx: DiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  console.log(
    "### 2a: Connector status (user must configure via OAuth login or API key)",
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `The ${ctx.label} connector is not available for this account.`,
    );
  } else if (status.runAccount?.state === "context-unavailable") {
    console.log(
      runConnectorAccountUnavailableMessage(status.runAccount.reason),
    );
  } else if (status.runAccount?.state === "not-admitted") {
    console.log(`No ${ctx.label} account was admitted for this run.`);
    console.log(
      "Connect or change the thread selection, then start a new run.",
    );
  } else if (status.runAccount?.state === "metadata-unavailable") {
    console.log(`Account used by this run: ${status.runAccount.connectionId}`);
    console.log("Current account metadata is unavailable or deleted.");
    console.log("Select an available account, then start a new run.");
  } else if (!status.isConnected) {
    console.log(`The ${ctx.label} connector is not connected.`);
    if (ctx.agentId && hasPermission) {
      const connectUrl = connectorActionUrl({
        origin: ctx.platformOrigin,
        path: `/connectors/${ctx.connectorSlug}/connect`,
        agentId: ctx.agentId,
      });
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
      printCallbackActionUrlExample(connectUrl, ctx.agentId);
    } else if (!ctx.agentId) {
      const connectUrl = connectorActionUrl({
        origin: ctx.platformOrigin,
        path: `/connectors/${ctx.connectorSlug}/connect`,
      });
      console.log(`Connect it at: [Connect ${ctx.label}](${connectUrl})`);
    }
  } else if (status.isExpired) {
    const url = connectorActionUrl({
      origin: ctx.platformOrigin,
      path:
        status.runAccount?.state === "available"
          ? `/connectors/${ctx.connectorSlug}/reconnect/${status.runAccount.connectionId}`
          : `/connectors/${ctx.connectorSlug}/connect`,
      agentId: ctx.agentId,
    });
    if (status.runAccount?.state === "available") {
      console.log(`Account used by this run: ${status.runAccount.label}`);
      console.log(`Connection ID: ${status.runAccount.connectionId}`);
    }
    console.log(
      `The ${ctx.label} connector is connected but has expired and needs to be reconnected.`,
    );
    console.log(`Reconnect it at: [Reconnect ${ctx.label}](${url})`);
    printCallbackActionUrlExample(url, ctx.agentId);
    if (ctx.runBound) {
      console.log("After reconnecting, start a new run.");
    }
  } else {
    if (status.runAccount?.state === "available") {
      console.log(`Account used by this run: ${status.runAccount.label}`);
      console.log(`Connection ID: ${status.runAccount.connectionId}`);
    }
    console.log(`The ${ctx.label} connector is connected and active.`);
  }
  console.log("");
}

function printAgentAuthorizationStatus(
  ctx: DiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  if (!ctx.agentId) {
    console.log("OKOU_AGENT_ID is not set — cannot check agent authorization.");
  } else if (status.isExpired) {
    console.log(
      `Skipped — agent authorization can only be checked once the ${ctx.label} connector is reconnected (see 2a).`,
    );
  } else if (hasPermission) {
    console.log(
      status.isConnected
        ? `The ${ctx.label} connector is authorized for this agent.`
        : ctx.runBound
          ? `The ${ctx.label} connector is authorized for this agent, but an account is not available for this run.`
          : `The ${ctx.label} connector is authorized for this agent, but it is not connected.`,
    );
  } else {
    const url = connectorActionUrl({
      origin: ctx.platformOrigin,
      path: `/connectors/${ctx.connectorSlug}/authorize`,
      agentId: ctx.agentId,
    });
    console.log(
      status.isConnected
        ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}).`
        : ctx.runBound
          ? `The ${ctx.label} connector is not authorized for this agent (${ctx.agentId}), and an account is not available for this run.`
          : `The ${ctx.label} connector needs to be connected and authorized for this agent (${ctx.agentId}).`,
    );
    console.log(`Authorize it at: [Authorize ${ctx.label}](${url})`);
    printCallbackActionUrlExample(url, ctx.agentId);
    if (ctx.runBound) {
      console.log("After authorizing it, start a new run.");
    }
  }
}

function printConnectorAuthorizationStatus(
  ctx: DiagContext,
  status: ConnectorConfigurationStatus,
  hasPermission: boolean,
): void {
  console.log(
    "### 2b: Agent authorization (user must authorize agent to use this connector)",
  );
  console.log("");
  if (!ctx.connectorAvailable) {
    console.log(
      `Skipped — the ${ctx.label} connector is not available for this account.`,
    );
  } else {
    printAgentAuthorizationStatus(ctx, status, hasPermission);
  }
  console.log(
    `This run uses agent-scoped connector authorization for ${ctx.label} access.`,
  );
  console.log("");
}

function checkEnvironmentNames(ctx: DiagContext): void {
  console.log("## Step 1: Sandbox environment name");
  console.log("");
  if (ctx.environmentNames === null) {
    console.log(
      "Environment metadata is unavailable for this run's sanitized firewall entry, so no environment name was guessed.",
    );
    console.log("");
    return;
  }
  if (ctx.environmentNames.length === 0) {
    console.log(
      "The matched API route does not use a sandbox environment name.",
    );
    console.log("");
    return;
  }

  let environmentPresent = false;
  for (const environmentName of ctx.environmentNames) {
    const present = Boolean(process.env[environmentName]);
    environmentPresent ||= present;
    console.log(
      `Checking process.env.${environmentName}: ${present ? "present" : "not present"}`,
    );
  }
  if (environmentPresent) {
    console.log(
      "At least one connector value is present in the sandbox environment. These values may be non-secret connector settings or credential placeholders; real credentials are never injected and are resolved at the network boundary for registered base URLs.",
    );
  } else {
    console.log(
      "No value found for these environment names. Note: credential replacement at the network boundary is independent of these names — the proxy injects auth headers based on the destination URL.",
    );
  }
  console.log("");
}

async function checkConnectorStatus(ctx: DiagContext): Promise<{
  readonly isConnected: boolean;
  readonly isExpired: boolean;
  readonly hasPermission: boolean;
}> {
  console.log("## Step 2: Connector configuration");
  console.log("");
  console.log(
    "A Connector holds the real credentials (OAuth tokens or API keys) for an external service. These credentials are never injected into the sandbox. Instead, when the sandbox sends an HTTP request to a base URL registered by the Connector, the network boundary intercepts the request and replaces the auth headers with real credentials. For this to work, three conditions must be met:",
  );
  console.log("");

  const [configuration, enabledConnectorSlugs] = await Promise.all([
    ctx.runBound
      ? resolveRunConnectorAccountLookups([
          { kind: "builtin", connectorSlug: ctx.connectorSlug },
        ]).then((lookups) => {
          const runAccount = lookups[0];
          if (!runAccount) {
            throw new Error("Missing run account lookup for connector");
          }
          return {
            isConnected: runAccount.state === "available",
            isExpired:
              runAccount.state === "available" &&
              runAccount.metadata.connectionStatus === "reconnect-required",
            runAccount,
          } satisfies ConnectorConfigurationStatus;
        })
      : getConnector(ctx.connectorSlug).then((connector) => {
          return {
            isConnected: connector !== null,
            isExpired: connector?.connectionStatus === "reconnect-required",
            runAccount: null,
          } satisfies ConnectorConfigurationStatus;
        }),
    ctx.agentId ? getAgentUserConnectors(ctx.agentId) : Promise.resolve(null),
  ]);

  const hasPermission =
    enabledConnectorSlugs !== null &&
    enabledConnectorSlugs.includes(ctx.connectorSlug);

  printConnectorConnectionStatus(ctx, configuration, hasPermission);
  printConnectorAuthorizationStatus(ctx, configuration, hasPermission);

  return {
    isConnected: configuration.isConnected,
    isExpired: configuration.isExpired,
    hasPermission,
  };
}

function checkConnectorDomains(ctx: DiagContext): boolean | null {
  console.log(
    "### 2c: Registered base URLs (credential replacement only applies to URLs matching these prefixes)",
  );
  console.log("");

  switch (ctx.run.status) {
    case "not-scoped":
      console.log(
        "This diagnostic is not scoped to a run — skipping the run base URL check.",
      );
      console.log("");
      return null;
    case "not-configured":
      console.log(
        `No configuration found for the ${ctx.label} connector in this run.`,
      );
      console.log(
        "This means no base URLs are registered for credential replacement for this connector.",
      );
      console.log("");
      return false;
    case "configured":
      console.log(
        `The ${ctx.label} connector is configured for this run with the following base URLs:`,
      );
      for (const base of ctx.run.bases) {
        console.log(`  - ${base}`);
      }
      console.log("");
      if (ctx.credentialResolution === "network-boundary") {
        console.log(
          "Credentials are resolved at the network boundary for requests matching these registered base URLs.",
        );
      }
      console.log("");
      return true;
  }
}

function printUnavailablePolicy(
  policy: Extract<
    ConnectorCheckPolicy,
    {
      readonly outcome: "unavailable";
    }
  >,
): void {
  switch (policy.basis) {
    case "not-run-scoped":
      console.log(
        "Result: Permission policy is unavailable because this diagnostic is not scoped to a run.",
      );
      return;
    case "policies-unavailable":
      console.log(
        "Result: Network policies are unavailable for this run, so the permission status cannot be determined.",
      );
      return;
    case "connector-not-configured":
      console.log(
        "Result: The connector is not configured for this run, so requests cannot receive credentials.",
      );
      return;
  }
}

function printNamedPolicyResult(
  connectorSlug: string,
  permission: string,
  policy: ConnectorCheckPolicy,
  agentId: string | undefined,
  request: UrlDiagnosticRequest | undefined,
): void {
  switch (policy.outcome) {
    case "allow": {
      switch (policy.basis) {
        case "allow-list":
          console.log(
            `Result: "${permission}" is in the allow list — allowed.`,
          );
          return;
        case "not-blocked":
          console.log(
            `Result: "${permission}" is not blocked by the deny or ask list — allowed.`,
          );
          return;
        case "no-policy":
          console.log(
            `Result: No policy entry exists for this connector — "${permission}" is allowed.`,
          );
          return;
        case "unknown-policy":
          console.log(
            `Result: The server policy allows "${permission}" through the unknown-endpoint policy.`,
          );
          return;
      }
      break;
    }
    case "deny":
      console.log(
        policy.basis === "deny-list"
          ? `Result: "${permission}" is in the deny list — denied.`
          : `Result: The unknown-endpoint policy denies "${permission}".`,
      );
      printPermissionRequestCommands(
        connectorSlug,
        permission,
        agentId,
        "To request this permission, run",
        request,
      );
      return;
    case "ask":
      console.log(
        policy.basis === "ask-list"
          ? `Result: "${permission}" is in the ask list — blocked until approval.`
          : `Result: The unknown-endpoint policy blocks "${permission}" until approval.`,
      );
      printPermissionRequestCommands(
        connectorSlug,
        permission,
        agentId,
        "To request this permission, run",
        request,
      );
      return;
    case "unavailable":
      printUnavailablePolicy(policy);
      return;
  }
}

function permissionRequestCommand(
  connectorSlug: string,
  permission: string,
  request: UrlDiagnosticRequest,
): string {
  return `okou connector permission-request ${shellQuoteArg(connectorSlug)} --permission ${shellQuoteArg(permission)} --url ${shellQuoteArg(request.url)} --method ${shellQuoteArg(request.method)}`;
}

function printPermissionRequestCommands(
  connectorSlug: string,
  permission: string,
  agentId: string | undefined,
  introduction: string,
  request: UrlDiagnosticRequest | undefined,
): void {
  if (request === undefined) {
    console.log(
      "Diagnose the failed request with okou connector check --url <FAILED_URL> --method <METHOD> before requesting this permission.",
    );
    return;
  }
  const command = permissionRequestCommand(connectorSlug, permission, request);
  console.log(`${introduction}: ${command}`);
  if (!currentChatSupportsActionCallback(agentId)) {
    return;
  }

  console.log("");
  console.log(
    "Or, if this is the only connector or permission action needed, run the callback command below. After the user completes this action, Okou will automatically start the next round with the callback prompt:",
  );
  console.log(`${command} --callback-prompt "${CALLBACK_PROMPT_PLACEHOLDER}"`);
}

function printUnknownEndpointPolicy(
  connectorSlug: string,
  policy: ConnectorCheckPolicy,
  agentId: string | undefined,
  request: UrlDiagnosticRequest,
): void {
  switch (policy.outcome) {
    case "allow":
      console.log(
        policy.basis === "no-policy"
          ? "Result: No policy entry exists for this connector, so the request is allowed."
          : "Result: No permission matched. The unknown endpoint policy allows this request.",
      );
      return;
    case "deny":
      console.log(
        "Result: No permission matched. The unknown endpoint policy denies this request.",
      );
      printPermissionRequestCommands(
        connectorSlug,
        "__unknown__",
        agentId,
        "To request access to unknown endpoints, run",
        request,
      );
      return;
    case "ask":
      console.log(
        "Result: No permission matched. The unknown endpoint policy requires approval.",
      );
      printPermissionRequestCommands(
        connectorSlug,
        "__unknown__",
        agentId,
        "To request access to unknown endpoints, run",
        request,
      );
      return;
    case "unavailable":
      printUnavailablePolicy(policy);
      return;
  }
}

function printUrlPermissionDiagnostic(
  request: UrlDiagnosticRequest,
  result: ResolvedUrlDiagnostic,
  agentId: string | undefined,
): void {
  console.log("## Step 3: Permission policy check (auto-detected from URL)");
  console.log("");
  console.log(
    `Matching ${result.method} ${result.relativePath} (relative to base URL ${result.base}) against the ${result.connector.label} connector's permission rules.`,
  );
  console.log("");

  if (result.permission.kind === "matched") {
    console.log(
      `Matched permissions: [${result.permission.permissions
        .map((permission) => {
          return permission.name;
        })
        .join(", ")}]`,
    );
    console.log("");
    for (const permission of result.permission.permissions) {
      printNamedPolicyResult(
        result.connector.connectorSlug,
        permission.name,
        permission.policy,
        agentId,
        request,
      );
    }
  } else {
    console.log(
      `No named permission matches ${result.method} ${result.relativePath}. This request falls through to the unknown-endpoint policy.`,
    );
    console.log("");
    printUnknownEndpointPolicy(
      result.connector.connectorSlug,
      result.permission.policy,
      agentId,
      request,
    );
  }
  console.log("");
}

function printEnvironmentPermissionDiagnostic(
  result: ResolvedEnvironmentDiagnostic,
  permissionName: string | undefined,
  agentId: string | undefined,
): void {
  if (result.permission === null) {
    return;
  }
  if (permissionName === undefined) {
    throw new Error(
      "Connector diagnostic returned a permission outcome without a requested permission.",
    );
  }
  console.log("## Step 3: Permission policy check");
  console.log("");
  console.log(
    `Checking permission: "${permissionName}" for the ${result.connector.label} connector.`,
  );
  console.log("");
  printNamedPolicyResult(
    result.connector.connectorSlug,
    permissionName,
    result.permission,
    agentId,
    undefined,
  );
  console.log("");
}

function printRediagnoseHint(
  opts: CheckConnectorOptions,
  method: string,
): void {
  const args: string[] = [];
  if (opts.url !== undefined) {
    args.push(`--url ${shellQuoteArg(stripUrlQueryAndFragment(opts.url))}`);
    if (opts.connector !== undefined) {
      args.push(`--connector ${shellQuoteArg(opts.connector)}`);
    }
    if (opts.envName !== undefined) {
      args.push(`--env-name ${shellQuoteArg(opts.envName)}`);
    }
    if (method !== "GET") {
      args.push(`--method ${shellQuoteArg(method)}`);
    }
  } else if (opts.envName !== undefined) {
    args.push(`--env-name ${shellQuoteArg(opts.envName)}`);
  }
  if (opts.checkPermission !== undefined) {
    args.push(`--check-permission ${shellQuoteArg(opts.checkPermission)}`);
  }
  console.log(
    `To re-diagnose after changes, run: okou connector check ${args.join(" ")}`,
  );
}

export const checkConnectorCommand = new Command()
  .name("check")
  .description(
    "Diagnose connector health: environment names, connector configuration, and permission policies",
  )
  .addOption(
    new Option(
      "--env-name <ENV_NAME>",
      "The connector environment name to check (e.g. GITHUB_TOKEN)",
    ),
  )
  .addOption(
    new Option(
      "--url <URL>",
      "A full URL to diagnose — matches connector ownership, route environment names, and permission (e.g. https://api.github.com/repos/owner/repo)",
    ),
  )
  .addOption(
    new Option(
      "--connector <slug>",
      "Select the connector when multiple connectors own the same URL route",
    ),
  )
  .addOption(
    new Option(
      "--method <METHOD>",
      "HTTP method to use when matching permissions with --url",
    ).default("GET"),
  )
  .addOption(
    new Option(
      "--check-permission <name>",
      "Check whether a specific permission is allowed or denied (e.g. contents:read)",
    ),
  )
  .addHelpText(
    "after",
    `
Examples:
  okou connector check --env-name GITHUB_TOKEN
  okou connector check --url https://api.github.com/repos/owner/repo
  okou connector check --url https://api.accounts.nintendo.com/2.0.0/users/me --connector nintendo-store
  okou connector check --url https://slack.com/api/chat.postMessage --method POST
  okou connector check --env-name SLACK_TOKEN --check-permission chat:write

How connectors work:
  A Connector holds the real credentials for an external service. These credentials
  are never injected into the sandbox. Instead, when the sandbox sends an HTTP
  request to a base URL registered by the Connector, the network boundary intercepts
  the request and replaces the auth headers with real credentials.

  This command checks each part of that pipeline and reports what it finds.`,
  )
  .action(
    withErrorHandler(async (opts: CheckConnectorOptions, command: Command) => {
      validateCheckConnectorOptions(opts, command);
      if (isComputerUseCheckTarget(opts)) {
        printComputerUsePermissionGuidance();
        return;
      }
      const method = opts.method.toUpperCase();
      const request = buildDiagnosticRequest(opts, method);
      const diagnostic = await diagnoseConnectorCheck(request);
      const result = resolveConnectorCheckDiagnostic(request, diagnostic);

      printDiagnosticSummary(request, result);
      console.log("");

      const platformUrl = toPlatformUrl(await getApiUrl());
      const ctx: DiagContext = {
        environmentNames: diagnosticEnvironmentNames(result),
        connectorSlug: result.connector.connectorSlug,
        label: result.connector.label,
        connectorAvailable: result.connector.visibility === "available",
        credentialResolution: result.connector.credentialResolution,
        run: result.run,
        platformOrigin: platformUrl.origin,
        agentId: getOkouAgentId(),
        runBound: isRunBoundConnectorContext(),
      };

      checkEnvironmentNames(ctx);
      const { isConnected, isExpired, hasPermission } =
        await checkConnectorStatus(ctx);
      const configuredForRun = checkConnectorDomains(ctx);

      if (configuredForRun === false) {
        console.log(
          `Steps 1-2 summary: The ${ctx.label} connector is not configured for this run. Check the agent authorization settings, then start a new run after updating them.`,
        );
      } else if (isConnected && !isExpired && hasPermission) {
        console.log(
          `Steps 1-2 summary: The ${ctx.label} connector is connected, active, and authorized. Outbound requests to the registered base URLs will have credentials injected at the network boundary.`,
        );
      }
      console.log("");

      if (result.mode === "url") {
        printUrlPermissionDiagnostic(
          requireUrlRequest(request),
          result,
          ctx.agentId,
        );
      } else {
        printEnvironmentPermissionDiagnostic(
          result,
          request.mode === "environment" ? request.permission : undefined,
          ctx.agentId,
        );
      }

      printRediagnoseHint(opts, method);
    }),
  );
