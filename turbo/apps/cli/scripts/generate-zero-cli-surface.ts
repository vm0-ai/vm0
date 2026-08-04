import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Argument, Command, Option } from "commander";

const SCHEMA_VERSION = 1;
const HELP_WIDTH = 100;
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const INVENTORY_PATH = fileURLToPath(
  new URL("../generated/zero-cli-surface.v1.json", import.meta.url),
);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SurfaceDefaultValue {
  present: boolean;
  value: JsonValue | null;
  description: string | null;
}

interface SurfaceArgument {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  choices: string[];
  default: SurfaceDefaultValue;
}

interface SurfaceOption {
  flags: string;
  name: string;
  attributeName: string;
  short: string | null;
  long: string | null;
  aliases: string[];
  description: string;
  valueRequirement: "none" | "required" | "optional";
  mandatory: boolean;
  variadic: boolean;
  negated: boolean;
  hidden: boolean;
  implicit: boolean;
  choices: string[];
  default: SurfaceDefaultValue;
}

interface SurfaceImplicitHelpCommand {
  name: string;
  aliases: string[];
  description: string;
  arguments: SurfaceArgument[];
}

type SurfaceCapabilityGate =
  | { mode: "always" }
  | { mode: "anyOf"; capabilities: string[] }
  | { mode: "hidden" };

interface SurfaceVisibilityRule {
  capabilityGate: SurfaceCapabilityGate;
  featureSwitch: string | null;
  runOnly: boolean;
}

interface RuntimeVisibilityRule {
  capability: string | readonly string[] | null | undefined;
  featureSwitch: string | undefined;
  runOnly: boolean;
}

interface SurfaceCommand {
  path: string[];
  name: string;
  aliases: string[];
  description: string;
  listingDescription: string;
  summary: string;
  usage: string;
  hidden: boolean;
  arguments: SurfaceArgument[];
  options: SurfaceOption[];
  implicitHelpCommand: SurfaceImplicitHelpCommand | null;
  helpText: string;
  visibility: SurfaceVisibilityRule | null;
}

interface ZeroCliSurfaceInventory {
  $schema: string;
  schemaVersion: number;
  extractionContext: {
    helpWidth: number;
    environment: {
      ZERO_TOKEN: "unset";
      ZERO_CHAT_THREAD_ID: "unset";
      ZERO_AGENT_ID: "unset";
    };
  };
  commands: SurfaceCommand[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toJsonValue(value: unknown, location: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${location} has a non-finite numeric default`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      return toJsonValue(item, `${location}[${index}]`);
    });
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`${location} has a non-JSON object default`);
    }
    const result: { [key: string]: JsonValue } = {};
    const entries = Object.entries(value).sort(([left], [right]) => {
      return compareText(left, right);
    });
    for (const [key, item] of entries) {
      result[key] = toJsonValue(item, `${location}.${key}`);
    }
    return result;
  }
  throw new Error(`${location} has a non-JSON default of type ${typeof value}`);
}

function extractDefaultValue(
  value: unknown,
  description: string | undefined,
  location: string,
): SurfaceDefaultValue {
  const present = value !== undefined;
  return {
    present,
    value: present ? toJsonValue(value, location) : null,
    description: description ?? null,
  };
}

function extractArgument(
  argument: Argument,
  commandPath: readonly string[],
): SurfaceArgument {
  const name = argument.name();
  return {
    name,
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    choices: [...(argument.argChoices ?? [])],
    default: extractDefaultValue(
      argument.defaultValue,
      argument.defaultValueDescription,
      `${commandPath.join(" ")} argument ${name}`,
    ),
  };
}

function extractOption(
  option: Option,
  commandPath: readonly string[],
  implicit: boolean,
): SurfaceOption {
  const canonicalFlag = option.long ?? option.short;
  const aliases: string[] = [];
  if (option.short && option.short !== canonicalFlag) {
    aliases.push(option.short);
  }
  if (option.long && option.long !== canonicalFlag) {
    aliases.push(option.long);
  }

  return {
    flags: option.flags,
    name: option.name(),
    attributeName: option.attributeName(),
    short: option.short ?? null,
    long: option.long ?? null,
    aliases: aliases.sort(compareText),
    description: option.description,
    valueRequirement: option.required
      ? "required"
      : option.optional
        ? "optional"
        : "none",
    mandatory: option.mandatory,
    variadic: option.variadic,
    negated: option.negate,
    hidden: option.hidden,
    implicit,
    choices: [...(option.argChoices ?? [])],
    default: extractDefaultValue(
      option.defaultValue,
      option.defaultValueDescription,
      `${commandPath.join(" ")} option ${option.flags}`,
    ),
  };
}

function extractOptions(
  command: Command,
  commandPath: readonly string[],
): SurfaceOption[] {
  const explicitOptions = new Set(command.options);
  const implicitOptions = command
    .createHelp()
    .visibleOptions(command)
    .filter((option) => {
      return !explicitOptions.has(option);
    });
  return [
    ...command.options.map((option) => {
      return extractOption(option, commandPath, false);
    }),
    ...implicitOptions.map((option) => {
      return extractOption(option, commandPath, true);
    }),
  ].sort((left, right) => {
    return compareText(left.flags, right.flags);
  });
}

function extractImplicitHelpCommand(
  command: Command,
  commandPath: readonly string[],
): SurfaceImplicitHelpCommand | null {
  const explicitCommands = new Set(command.commands);
  const implicitCommands = command
    .createHelp()
    .visibleCommands(command)
    .filter((child) => {
      return !explicitCommands.has(child);
    });
  if (implicitCommands.length > 1) {
    throw new Error(
      `${commandPath.join(" ")} exposes multiple implicit help commands`,
    );
  }
  const [helpCommand] = implicitCommands;
  if (!helpCommand) return null;
  const helpPath = [...commandPath, helpCommand.name()];
  return {
    name: helpCommand.name(),
    aliases: [...helpCommand.aliases()].sort(compareText),
    description: helpCommand.description(),
    arguments: helpCommand.registeredArguments.map((argument) => {
      return extractArgument(argument, helpPath);
    }),
  };
}

function renderHelp(command: Command): string {
  let output = "";
  command.configureOutput({
    writeOut: (text) => {
      output += text;
    },
    writeErr: (text) => {
      output += text;
    },
    getOutHelpWidth: () => {
      return HELP_WIDTH;
    },
    getErrHelpWidth: () => {
      return HELP_WIDTH;
    },
    getOutHasColors: () => {
      return false;
    },
    getErrHasColors: () => {
      return false;
    },
  });
  command.outputHelp();
  return output;
}

function extractVisibilityRule(
  rule: RuntimeVisibilityRule,
): SurfaceVisibilityRule {
  let capabilityGate: SurfaceCapabilityGate;
  if (rule.capability === undefined) {
    capabilityGate = { mode: "hidden" };
  } else if (rule.capability === null) {
    capabilityGate = { mode: "always" };
  } else {
    capabilityGate = {
      mode: "anyOf",
      capabilities: (typeof rule.capability === "string"
        ? [rule.capability]
        : [...rule.capability]
      ).sort(compareText),
    };
  }
  return {
    capabilityGate,
    featureSwitch: rule.featureSwitch ?? null,
    runOnly: rule.runOnly,
  };
}

function appendCommand(
  commands: SurfaceCommand[],
  command: Command,
  path: string[],
  hidden: boolean,
  rootHelpText: string,
  topLevelListingDescriptions: ReadonlyMap<string, string>,
  getVisibilityRule: (name: string) => RuntimeVisibilityRule,
): void {
  const summary = command.summary();
  const topLevelListingDescription = topLevelListingDescriptions.get(
    command.name(),
  );
  let listingDescription: string;
  if (path.length === 2) {
    if (topLevelListingDescription === undefined) {
      throw new Error(`${command.name()} has no top-level listing description`);
    }
    listingDescription = topLevelListingDescription;
  } else {
    listingDescription = summary.length > 0 ? summary : command.description();
  }
  commands.push({
    path,
    name: command.name(),
    aliases: [...command.aliases()].sort(compareText),
    description: command.description(),
    listingDescription,
    summary,
    usage: command.usage(),
    hidden,
    arguments: command.registeredArguments.map((argument) => {
      return extractArgument(argument, path);
    }),
    options: extractOptions(command, path),
    implicitHelpCommand: extractImplicitHelpCommand(command, path),
    helpText: path.length === 1 ? rootHelpText : renderHelp(command),
    visibility:
      path.length === 2
        ? extractVisibilityRule(getVisibilityRule(command.name()))
        : null,
  });

  const visibleChildren = new Set(
    command
      .createHelp()
      .visibleCommands(command)
      .filter((child) => {
        return command.commands.includes(child);
      }),
  );
  for (const child of command.commands) {
    appendCommand(
      commands,
      child,
      [...path, child.name()],
      !visibleChildren.has(child),
      rootHelpText,
      topLevelListingDescriptions,
      getVisibilityRule,
    );
  }
}

function extractInventory(
  program: Command,
  rootHelpText: string,
  topLevelListingDescriptions: ReadonlyMap<string, string>,
  getVisibilityRule: (name: string) => RuntimeVisibilityRule,
): ZeroCliSurfaceInventory {
  const commands: SurfaceCommand[] = [];
  appendCommand(
    commands,
    program,
    [program.name()],
    false,
    rootHelpText,
    topLevelListingDescriptions,
    getVisibilityRule,
  );
  commands.sort((left, right) => {
    return compareText(left.path.join("\0"), right.path.join("\0"));
  });

  return {
    $schema: "./zero-cli-surface.schema.v1.json",
    schemaVersion: SCHEMA_VERSION,
    extractionContext: {
      helpWidth: HELP_WIDTH,
      environment: {
        ZERO_TOKEN: "unset",
        ZERO_CHAT_THREAD_ID: "unset",
        ZERO_AGENT_ID: "unset",
      },
    },
    commands,
  };
}

function configureExtractionEnvironment(): void {
  Object.assign(globalThis, {
    __CLI_VERSION__: "0.0.0-surface-inventory",
    __DEFAULT_SENTRY_DSN__: "",
  });
  delete process.env.ZERO_TOKEN;
  delete process.env.ZERO_CHAT_THREAD_ID;
  delete process.env.ZERO_AGENT_ID;
  process.env.SENTRY_DSN = "";
}

async function generateInventory(): Promise<string> {
  configureExtractionEnvironment();
  // CLI modules read tsup-injected globals during evaluation, so tooling must
  // install deterministic values before loading the production entry point.
  const {
    ZERO_COMMAND_DEFINITIONS,
    createZeroProgram,
    getZeroCommandVisibilityRule,
    registerZeroCommands,
  } = await import("../src/zero.js");

  const defaultProgram = createZeroProgram();
  registerZeroCommands(defaultProgram);
  const rootHelpText = renderHelp(defaultProgram);
  const visibleTopLevelCommandNames = new Set(
    defaultProgram
      .createHelp()
      .visibleCommands(defaultProgram)
      .filter((command) => {
        return defaultProgram.commands.includes(command);
      })
      .map((command) => {
        return command.name();
      }),
  );

  const completeProgram = createZeroProgram();
  const topLevelListingDescriptions = new Map<string, string>();
  for (const definition of ZERO_COMMAND_DEFINITIONS) {
    topLevelListingDescriptions.set(definition.name, definition.description);
    const command = await definition.load();
    if (command.name() !== definition.name) {
      throw new Error(
        `Zero command definition ${definition.name} loaded ${command.name()}`,
      );
    }
    completeProgram.addCommand(
      command,
      visibleTopLevelCommandNames.has(command.name()) ? {} : { hidden: true },
    );
  }

  const inventory = extractInventory(
    completeProgram,
    rootHelpText,
    topLevelListingDescriptions,
    getZeroCommandVisibilityRule,
  );
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--check")) {
    throw new Error("Usage: generate-zero-cli-surface.ts [--check]");
  }

  const generated = await generateInventory();
  const inventoryDisplayPath = relative(PACKAGE_ROOT, INVENTORY_PATH);
  if (args[0] === "--check") {
    const committed = readFileSync(INVENTORY_PATH, "utf8");
    if (committed !== generated) {
      throw new Error(
        `${inventoryDisplayPath} is stale; run pnpm --filter @vm0/cli generate:surface`,
      );
    }
    console.log(`${inventoryDisplayPath} is current`);
    return;
  }

  mkdirSync(dirname(INVENTORY_PATH), { recursive: true });
  writeFileSync(INVENTORY_PATH, generated);
  console.log(`Generated ${inventoryDisplayPath}`);
}

await main();
