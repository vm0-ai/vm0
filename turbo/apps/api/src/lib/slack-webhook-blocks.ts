import type { Block, KnownBlock, MarkdownBlock, View } from "@slack/web-api";

import { env } from "./env";

type SlackBlocks = (Block | KnownBlock)[];

export const AGENT_PICKER_CALLBACK_ID = "switch_agent_modal";
export const AGENT_PICKER_BLOCK_ID = "agent_select_block";
export const AGENT_PICKER_ACTION_ID = "agent_select";
export const AGENT_PICKER_ORG_DEFAULT_VALUE = "__org_default__";

export const MODEL_PICKER_CALLBACK_ID = "model_preference_modal";
export const MODEL_PICKER_BLOCK_ID = "model_select_block";
export const MODEL_PICKER_ACTION_ID = "model_select";

interface AgentPickerOption {
  readonly composeId: string;
  readonly name: string;
  readonly displayName?: string | null;
}

interface ModelPickerOption {
  readonly model: string;
  readonly label: string;
  readonly isDefault?: boolean;
}

interface AppHomeOptions {
  readonly isLinked: boolean;
  readonly isInstalled?: boolean;
  readonly vm0UserId?: string;
  readonly userEmail?: string;
  readonly agentName?: string;
  readonly isOverrideActive?: boolean;
  readonly canSwitch?: boolean;
  readonly loginUrl?: string;
}

function appUrl(): string {
  return env("VM0_WEB_URL");
}

function buildAppHomeHeaderBlocks(): SlackBlocks {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Welcome to Zero! :wave:" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Connect your AI agents to Slack and interact with them through messages.",
      },
    },
    { type: "divider" },
  ];
}

function buildAppHomeNotInstalledBlocks(): SlackBlocks {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":warning: *Zero is not installed for this workspace*\nAsk a workspace admin to install Zero from the platform.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open Zero Settings" },
          url: `${appUrl()}/works`,
          action_id: "home_open_settings",
          style: "primary",
        },
      ],
    },
  ];
}

function buildAppHomeDisconnectedBlocks(loginUrl?: string): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: ":x: *Account not connected*" },
    },
  ];
  if (!loginUrl) {
    return blocks;
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Connect" },
        url: loginUrl,
        action_id: "home_login_prompt",
        style: "primary",
      },
    ],
  });
  return blocks;
}

function buildAppHomeAccountBlock(options: AppHomeOptions): SlackBlocks {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Connected to Zero*\nAccount: ${
          options.userEmail || options.vm0UserId
        }`,
      },
    },
  ];
}

function buildAppHomeAgentBlocks(options: AppHomeOptions): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: options.isOverrideActive
          ? ":robot_face: *Your Agent*"
          : ":robot_face: *Workspace Agent*",
      },
    },
  ];

  if (options.agentName) {
    const settingsButton = {
      type: "button" as const,
      text: { type: "plain_text" as const, text: "Settings" },
      url: `${appUrl()}/works`,
      action_id: "home_environment_setup",
    };
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `AgentName: *${options.agentName}*`,
      },
      ...(options.canSwitch ? {} : { accessory: settingsButton }),
    });
    if (options.canSwitch) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Switch" },
            action_id: "home_switch_agent",
            style: "primary",
          },
          settingsButton,
        ],
      });
    }
    return blocks;
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "_No agent configured yet._" },
  });
  return blocks;
}

function buildAppHomeUsageBlocks(): SlackBlocks {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":bulb: *Here are some things you can do:*",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Commands*\n\u2022 `/zero connect` - Connect to Zero\n\u2022 `/zero disconnect` - Disconnect from Zero",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Usage*\nSend a DM or `@Zero` in any channel to chat with your agents",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Disconnect Zero Account*\nThis will remove your Zero account connection",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Disconnect" },
        action_id: "home_disconnect",
        style: "danger",
        confirm: {
          title: { type: "plain_text", text: "Disconnect Zero Account" },
          text: {
            type: "plain_text",
            text: "This will remove your Zero account connection",
          },
          confirm: { type: "plain_text", text: "Disconnect" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      },
    },
  ];
}

export function buildAppHomeView(options: AppHomeOptions): View {
  const blocks = buildAppHomeHeaderBlocks();

  if (options.isInstalled === false) {
    return {
      type: "home",
      blocks: [...blocks, ...buildAppHomeNotInstalledBlocks()],
    };
  }

  if (!options.isLinked) {
    return {
      type: "home",
      blocks: [...blocks, ...buildAppHomeDisconnectedBlocks(options.loginUrl)],
    };
  }

  return {
    type: "home",
    blocks: [
      ...blocks,
      ...buildAppHomeAccountBlock(options),
      { type: "divider" },
      ...buildAppHomeAgentBlocks(options),
      { type: "divider" },
      ...buildAppHomeUsageBlocks(),
    ],
  };
}

export function buildErrorMessage(error: string): SlackBlocks {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:x: *Error*\n${error}` },
    },
  ];
}

export function buildLoginPromptMessage(loginUrl: string): SlackBlocks {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "To use Zero in Slack, please connect your account first.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          url: loginUrl,
          action_id: "login_prompt",
          style: "primary",
        },
      ],
    },
  ];
}

export function buildHelpMessage(opts?: {
  readonly canSwitch?: boolean;
  readonly canModel?: boolean;
}): SlackBlocks {
  const switchLine = opts?.canSwitch
    ? "\n\u2022 `/zero switch` - Choose which agent responds to your messages"
    : "";
  const modelLine = opts?.canModel
    ? "\n\u2022 `/zero model` - Choose your model"
    : "";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Zero Slack Bot Help*" },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Commands*\n\u2022 \`/zero connect\` - Connect to Zero${switchLine}${modelLine}\n\u2022 \`/zero disconnect\` - Disconnect from Zero`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Usage*\n\u2022 `@Zero <message>` - Send a message to your agent",
      },
    },
  ];
}

export function buildSuccessMessage(message: string): SlackBlocks {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: ${message}` },
    },
  ];
}

export function buildWelcomeMessage(agentName?: string): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":wave: *Hi! I'm Zero.*\n\nI can connect you to AI agents to help with your tasks.",
      },
    },
    { type: "divider" },
  ];

  if (agentName) {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Workspace Agent*\n\u2022 \`${agentName}\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n\u2022 Just describe what you need help with",
        },
      },
    );
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No workspace agent configured yet._" },
    });
  }

  return blocks;
}

const MARKDOWN_BLOCK_MAX_LENGTH = 12_000;

function buildMarkdownMessage(content: string): SlackBlocks {
  const truncationSuffix = "\n\n_(Message too long to view in Slack.)_";
  const text =
    content.length > MARKDOWN_BLOCK_MAX_LENGTH
      ? content.slice(0, MARKDOWN_BLOCK_MAX_LENGTH - truncationSuffix.length) +
        truncationSuffix
      : content;
  const block: MarkdownBlock = { type: "markdown", text };
  return [block];
}

export function buildAgentResponseMessage(
  content: string,
  logsUrl?: string,
  footerText?: string,
): SlackBlocks {
  const blocks: SlackBlocks = [...buildMarkdownMessage(content)];
  if (logsUrl) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `:clipboard: <${logsUrl}|Audit>` }],
    });
  }
  if (footerText) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: footerText }],
    });
  }
  return blocks;
}

export function buildAgentPickerModal(args: {
  readonly options: readonly AgentPickerOption[];
  readonly currentSelectedId: string | null;
  readonly orgDefaultName: string | null;
  readonly privateMetadata?: string;
}): View {
  const orgDefaultLabel = args.orgDefaultName
    ? `Use org default (${args.orgDefaultName})`
    : "Use org default";
  const selectOptions = [
    {
      text: { type: "plain_text" as const, text: orgDefaultLabel },
      value: AGENT_PICKER_ORG_DEFAULT_VALUE,
    },
    ...args.options.map((option) => {
      return {
        text: {
          type: "plain_text" as const,
          text: (option.displayName ?? option.name).slice(0, 75),
        },
        value: option.composeId,
      };
    }),
  ];
  const initialOption = args.currentSelectedId
    ? (selectOptions.find((option) => {
        return option.value === args.currentSelectedId;
      }) ?? selectOptions[0])
    : selectOptions[0];

  return {
    type: "modal",
    callback_id: AGENT_PICKER_CALLBACK_ID,
    title: { type: "plain_text", text: "Switch Agent" },
    submit: { type: "plain_text", text: "Switch" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose which agent should respond to your mentions and DMs. Only affects your own messages.",
        },
      },
      {
        type: "input",
        block_id: AGENT_PICKER_BLOCK_ID,
        label: { type: "plain_text", text: "Agent" },
        element: {
          type: "static_select",
          action_id: AGENT_PICKER_ACTION_ID,
          placeholder: { type: "plain_text", text: "Select an agent" },
          options: selectOptions,
          ...(initialOption && { initial_option: initialOption }),
        },
      },
    ],
    ...(args.privateMetadata && { private_metadata: args.privateMetadata }),
  };
}

function formatModelPickerOptionLabel(option: ModelPickerOption): string {
  if (!option.isDefault) {
    return option.label.slice(0, 75);
  }
  const suffix = " (workspace default)";
  if (option.label.length + suffix.length <= 75) {
    return `${option.label}${suffix}`;
  }
  return `${option.label.slice(0, 75 - suffix.length)}${suffix}`;
}

export function buildModelPickerModal(args: {
  readonly options: readonly ModelPickerOption[];
  readonly currentSelectedModel: string | null;
  readonly privateMetadata?: string;
}): View {
  const selectOptions = args.options.map((option) => {
    return {
      text: {
        type: "plain_text" as const,
        text: formatModelPickerOptionLabel(option),
      },
      value: option.model,
    };
  });
  const defaultModel = args.options.find((option) => {
    return option.isDefault;
  })?.model;
  const currentOption = args.currentSelectedModel
    ? selectOptions.find((option) => {
        return option.value === args.currentSelectedModel;
      })
    : undefined;
  const defaultOption = defaultModel
    ? selectOptions.find((option) => {
        return option.value === defaultModel;
      })
    : undefined;
  const initialOption = currentOption ?? defaultOption ?? selectOptions[0];

  return {
    type: "modal",
    callback_id: MODEL_PICKER_CALLBACK_ID,
    title: { type: "plain_text", text: "Switch Model" },
    submit: { type: "plain_text", text: "Switch" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose your model. This only affects your own runs.",
        },
      },
      {
        type: "input",
        block_id: MODEL_PICKER_BLOCK_ID,
        label: { type: "plain_text", text: "Model" },
        element: {
          type: "static_select",
          action_id: MODEL_PICKER_ACTION_ID,
          placeholder: { type: "plain_text", text: "Select a model" },
          options: selectOptions,
          ...(initialOption && { initial_option: initialOption }),
        },
      },
    ],
    ...(args.privateMetadata && { private_metadata: args.privateMetadata }),
  };
}

export function buildLoginMessage(loginUrl: string): SlackBlocks {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Please connect your account to use Zero in this workspace.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          url: loginUrl,
          action_id: "login",
          style: "primary",
        },
      ],
    },
  ];
}
