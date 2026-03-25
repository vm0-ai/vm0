import { Command } from "commander";
import chalk from "chalk";
import {
  CONNECTOR_TYPES,
  connectorTypeSchema,
  isFeatureEnabled,
  type ConnectorType,
} from "@vm0/core";
import {
  createZeroConnectorSession,
  getZeroConnectorSession,
  createZeroComputerConnector,
  deleteZeroComputerConnector,
  setZeroSecret,
} from "../../../lib/api";
import { getBaseUrl } from "../../../lib/api/core/client-factory";
import { getActiveOrg } from "../../../lib/api/config";
import { withErrorHandler } from "../../../lib/command";
import {
  checkComputerDependencies,
  startComputerServices,
} from "../../../lib/computer/start-services";
import { promptSelect, promptPassword } from "../../../lib/utils/prompt-utils";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render markdown help text for terminal display
 */
function renderHelpText(text: string): string {
  return text
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, label: string, url: string) => `${label} (${chalk.cyan(url)})`,
    )
    .replace(/\*\*([^*]+)\*\*/g, (_m, content: string) => chalk.bold(content))
    .replace(/^> (.+)$/gm, (_m, content: string) =>
      chalk.yellow(`  ${content}`),
    );
}

/**
 * Handle the API token connection flow
 */
async function connectViaApiToken(
  connectorType: ConnectorType,
  tokenValue?: string,
): Promise<void> {
  const config = CONNECTOR_TYPES[connectorType];
  const apiTokenConfig = config.authMethods["api-token"];
  if (!apiTokenConfig) {
    throw new Error(
      `${config.label} does not support API token authentication`,
    );
  }

  const secretEntries = Object.entries(apiTokenConfig.secrets);
  const inputSecrets: Record<string, string> = {};

  if (tokenValue && secretEntries.length === 1) {
    // Direct token via --token flag
    const [secretName] = secretEntries[0]!;
    inputSecrets[secretName] = tokenValue;
  } else {
    // Interactive: show instructions, then prompt for each secret
    if (apiTokenConfig.helpText) {
      console.log();
      console.log(renderHelpText(apiTokenConfig.helpText));
      console.log();
    }

    for (const [secretName, secretConfig] of secretEntries) {
      if (!secretConfig.required) continue;

      const value = await promptPassword(
        `${secretConfig.label}${secretConfig.placeholder ? chalk.dim(` (${secretConfig.placeholder})`) : ""}:`,
      );

      if (!value) {
        throw new Error("Cancelled");
      }

      inputSecrets[secretName] = value;
    }
  }

  for (const [name, value] of Object.entries(inputSecrets)) {
    await setZeroSecret({
      name,
      value,
      description: `API token for ${config.label} connector`,
    });
  }
  console.log(
    chalk.green(`\n✓ ${config.label} connected successfully via API token!`),
  );
}

/**
 * Handle computer connector flow
 */
async function connectComputer(): Promise<void> {
  await checkComputerDependencies();
  console.log(chalk.cyan("Setting up computer connector..."));

  const credentials = await createZeroComputerConnector();
  await startComputerServices(credentials);

  console.log(chalk.cyan("Disconnecting computer connector..."));
  await deleteZeroComputerConnector();
  console.log(chalk.green("✓ Disconnected computer"));
}

/**
 * Resolve which auth method to use for a connector
 */
async function resolveAuthMethod(
  connectorType: ConnectorType,
  tokenFlag?: string,
): Promise<"oauth" | "api-token"> {
  const config = CONNECTOR_TYPES[connectorType];
  const oauthFlag = CONNECTOR_TYPES[connectorType].featureFlag;
  const orgId = await getActiveOrg();
  const oauthAvailable =
    "oauth" in config.authMethods &&
    (!oauthFlag || (await isFeatureEnabled(oauthFlag, { orgId })));
  const apiTokenAvailable = "api-token" in config.authMethods;

  if (tokenFlag) {
    if (!apiTokenAvailable) {
      throw new Error(
        `${config.label} does not support API token authentication`,
      );
    }
    return "api-token";
  }

  if (oauthAvailable && apiTokenAvailable) {
    const selected = await promptSelect<"oauth" | "api-token">(
      `How would you like to connect ${config.label}?`,
      [
        { title: "OAuth (Sign in with browser)", value: "oauth" },
        {
          title: `API Token (${config.authMethods["api-token"]!.label})`,
          value: "api-token",
        },
      ],
    );
    if (!selected) {
      throw new Error("Cancelled");
    }
    return selected;
  }

  if (apiTokenAvailable) return "api-token";
  if (oauthAvailable) return "oauth";

  throw new Error(
    `${config.label} has no available auth methods. OAuth may not be enabled yet.`,
  );
}

/**
 * Handle OAuth device flow
 */
async function connectViaOAuth(connectorType: ConnectorType): Promise<void> {
  console.log(`Connecting ${chalk.cyan(connectorType)}...`);

  const session = await createZeroConnectorSession(connectorType);
  const apiUrl = await getBaseUrl();
  const verificationUrl = `${apiUrl}${session.verificationUrl}`;

  console.log(chalk.green("\nSession created"));
  console.log(chalk.cyan(`\nTo connect, visit: ${verificationUrl}`));
  console.log(
    `\nThe session expires in ${Math.floor(session.expiresIn / 60)} minutes.`,
  );
  console.log("\nWaiting for authorization...");

  const startTime = Date.now();
  const maxWaitTime = session.expiresIn * 1000;
  const pollInterval = (session.interval || 5) * 1000;
  let isFirstPoll = true;

  while (Date.now() - startTime < maxWaitTime) {
    if (!isFirstPoll) {
      await delay(pollInterval);
    }
    isFirstPoll = false;

    const status = await getZeroConnectorSession(connectorType, session.id);

    switch (status.status) {
      case "complete":
        console.log(
          chalk.green(`\n\n${connectorType} connected successfully!`),
        );
        return;
      case "expired":
        throw new Error("Session expired, please try again");
      case "error":
        throw new Error(
          `Connection failed: ${status.errorMessage || "Unknown error"}`,
        );
      case "pending":
        process.stdout.write(chalk.dim("."));
        break;
    }
  }

  throw new Error("Session timed out, please try again");
}

export const connectCommand = new Command()
  .name("connect")
  .description("Connect a third-party service (e.g., GitHub)")
  .argument("<type>", "Connector type (e.g., github)")
  .option("--token <value>", "API token value (skip interactive prompt)")
  .action(
    withErrorHandler(async (type: string, options: { token?: string }) => {
      const parseResult = connectorTypeSchema.safeParse(type);
      if (!parseResult.success) {
        const available = Object.keys(CONNECTOR_TYPES).join(", ");
        throw new Error(`Unknown connector type: ${type}`, {
          cause: new Error(`Available connectors: ${available}`),
        });
      }

      const connectorType = parseResult.data;

      if (connectorType === "computer") {
        await connectComputer();
        return;
      }

      const authMethod = await resolveAuthMethod(connectorType, options.token);

      if (authMethod === "api-token") {
        await connectViaApiToken(connectorType, options.token);
        return;
      }

      await connectViaOAuth(connectorType);
    }),
  );
