import type { Block, KnownBlock, View, MarkdownBlock } from "@slack/web-api";
import { getAppUrl } from "../url";

/**
 * Build the App Home tab view
 *
 * @param options - Configuration for the home view
 * @returns View definition for the Home tab
 */
export function buildAppHomeView(options: {
  isLinked: boolean;
  isInstalled?: boolean;
  vm0UserId?: string;
  userEmail?: string;
  agentName?: string;
  isOverrideActive?: boolean;
  canSwitch?: boolean;
  loginUrl?: string;
}): View {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Welcome to Zero! :wave:",
      },
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

  // Not installed — prompt to ask admin
  if (options.isInstalled === false) {
    blocks.push(
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
            text: {
              type: "plain_text",
              text: "Open Zero Settings",
            },
            url: `${getAppUrl()}/works`,
            action_id: "home_open_settings",
            style: "primary",
          },
        ],
      },
    );

    return {
      type: "home",
      blocks,
    };
  }

  // Account status
  if (options.isLinked) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Connected to Zero*\nAccount: ${options.userEmail || options.vm0UserId}`,
      },
    });
  } else {
    const connectBlocks: (Block | KnownBlock)[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":x: *Account not connected*",
        },
      },
    ];
    if (options.loginUrl) {
      connectBlocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Connect",
            },
            url: options.loginUrl,
            action_id: "home_login_prompt",
            style: "primary",
          },
        ],
      });
    }
    blocks.push(...connectBlocks);

    // Not connected — just show connect prompt, skip agents/commands
    return {
      type: "home",
      blocks,
    };
  }

  blocks.push({ type: "divider" });

  // Workspace Agent section
  const agentHeading = options.isOverrideActive
    ? ":robot_face: *Your Agent*"
    : ":robot_face: *Workspace Agent*";
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: agentHeading,
    },
  });

  if (options.agentName) {
    const settingsButton = {
      type: "button" as const,
      text: { type: "plain_text" as const, text: "Settings" },
      url: `${getAppUrl()}/works`,
      action_id: "home_environment_setup",
    };
    const agentBlock: KnownBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `AgentName: *${options.agentName}*`,
      },
      ...(options.canSwitch ? {} : { accessory: settingsButton }),
    };
    blocks.push(agentBlock);
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
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agent configured yet._",
      },
    });
  }

  blocks.push({ type: "divider" });

  // Help section
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":bulb: *Here are some things you can do:*",
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Commands*\n\u2022 \`/zero connect\` - Connect to Zero\n\u2022 \`/zero disconnect\` - Disconnect from Zero`,
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Usage*\nSend a DM or `@Zero` in any channel to chat with your agents",
    },
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Disconnect Zero Account*\nThis will remove your Zero account connection",
    },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: "Disconnect",
      },
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
  });

  return {
    type: "home",
    blocks,
  };
}

/**
 * Build an error message
 *
 * @param error - Error message
 * @returns Block Kit blocks
 */
export function buildErrorMessage(error: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:x: *Error*\n${error}`,
      },
    },
  ];
}

/**
 * Build a message prompting user to login
 *
 * @param loginUrl - URL to the login page
 * @returns Block Kit blocks
 */
export function buildLoginPromptMessage(
  loginUrl: string,
): (Block | KnownBlock)[] {
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
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "login_prompt",
          style: "primary",
        },
      ],
    },
  ];
}

/**
 * Build a welcome message for the Messages tab
 */
export function buildWelcomeMessage(
  agentName?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":wave: *Hi! I'm Zero.*\n\nI can connect you to AI agents to help with your tasks.",
      },
    },
    {
      type: "divider",
    },
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
      text: {
        type: "mrkdwn",
        text: "_No workspace agent configured yet._",
      },
    });
  }

  return blocks;
}

/**
 * Build a help message
 *
 * @param opts.canSwitch - Whether `/zero switch` is available for the caller.
 * @param opts.canModel - Whether `/zero model` is available for the caller.
 *   When unavailable, gated command lines are omitted so users aren't shown
 *   commands they cannot use. Defaults to `false` (the safe choice when the
 *   caller has no user/org context yet, e.g. pre-installation help).
 * @returns Block Kit blocks
 */
export function buildHelpMessage(opts?: {
  canSwitch?: boolean;
  canModel?: boolean;
}): (Block | KnownBlock)[] {
  const canSwitch = opts?.canSwitch ?? false;
  const canModel = opts?.canModel ?? false;
  const switchLine = canSwitch
    ? "\n\u2022 `/zero switch` - Choose which agent responds to your messages"
    : "";
  const modelLine = canModel
    ? "\n\u2022 `/zero model` - Choose your model"
    : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Zero Slack Bot Help*",
      },
    },
    {
      type: "divider",
    },
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

/**
 * Build a success message
 *
 * @param message - Success message
 * @returns Block Kit blocks
 */
export function buildSuccessMessage(message: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: ${message}`,
      },
    },
  ];
}

/**
 * Build markdown message blocks using Slack's native markdown block type.
 * Slack's markdown block accepts standard markdown (including tables, code blocks,
 * lists, blockquotes) and handles rendering internally.
 *
 * @see https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
 *
 * @param content - Standard markdown content
 * @returns Block Kit blocks
 */
const MARKDOWN_BLOCK_MAX_LENGTH = 12000;

function buildMarkdownMessage(content: string): (Block | KnownBlock)[] {
  // Markdown blocks have a cumulative 12,000 character limit per message.
  // If content exceeds that, truncate and indicate there is more.
  const truncationSuffix = "\n\n_(Message too long to view in Slack.)_";
  const truncated =
    content.length > MARKDOWN_BLOCK_MAX_LENGTH
      ? content.substring(
          0,
          MARKDOWN_BLOCK_MAX_LENGTH - truncationSuffix.length,
        ) + truncationSuffix
      : content;

  const block: MarkdownBlock = {
    type: "markdown",
    text: truncated,
  };

  return [block];
}

/**
 * Build an agent response message with optional logs link.
 *
 * The attribution footer renders as a single context block without a divider —
 * a deliberately weaker visual than `buildFooterBlocks`, which is reserved for
 * longer schedule/user footers from the outbound `/integrations/slack/message`
 * path. Callers pre-assemble `footerText` (e.g. `"Reply to <@U123> · Claude
 * Opus 4.7"`); this helper only decides how to render it.
 *
 * @param content - The agent's response content
 * @param logsUrl - Optional URL to the run logs
 * @param footerText - Optional pre-joined attribution text
 * @returns Block Kit blocks with response content
 */
export function buildAgentResponseMessage(
  content: string,
  logsUrl?: string,
  footerText?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [...buildMarkdownMessage(content)];

  // Emoji must be outside the link — Slack mobile doesn't render emoji inside <url|text>
  if (logsUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:clipboard: <${logsUrl}|Audit>`,
        },
      ],
    });
  }

  if (footerText) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: footerText,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build a divider + context block pair for message footers.
 *
 * @param text - The footer text (e.g. "Sent via my-agent")
 * @returns Divider and context blocks
 */
export function buildFooterBlocks(text: string): (Block | KnownBlock)[] {
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text,
        },
      ],
    },
  ];
}

export const AGENT_PICKER_CALLBACK_ID = "switch_agent_modal";
export const AGENT_PICKER_BLOCK_ID = "agent_select_block";
export const AGENT_PICKER_ACTION_ID = "agent_select";
export const AGENT_PICKER_ORG_DEFAULT_VALUE = "__org_default__";

export const MODEL_PICKER_CALLBACK_ID = "model_preference_modal";
export const MODEL_PICKER_BLOCK_ID = "model_select_block";
export const MODEL_PICKER_ACTION_ID = "model_select";

interface AgentPickerOption {
  composeId: string;
  name: string;
  displayName?: string | null;
}

/**
 * Build the "Switch Agent" modal view.
 *
 * `options` contains only agents the picker should offer to the user — the
 * caller is expected to have already filtered out the org's default agent,
 * which is represented by the dedicated "Use org default" entry. Slack caps
 * `static_select` at 100 options, so callers should cap/paginate upstream.
 */
export function buildAgentPickerModal(args: {
  options: AgentPickerOption[];
  currentSelectedId: string | null;
  orgDefaultName: string | null;
  privateMetadata?: string;
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
      const label = option.displayName ?? option.name;
      return {
        text: { type: "plain_text" as const, text: label.slice(0, 75) },
        value: option.composeId,
      };
    }),
  ];

  const initialOptionRaw = args.currentSelectedId
    ? selectOptions.find((option) => {
        return option.value === args.currentSelectedId;
      })
    : selectOptions[0];
  const initialOption = initialOptionRaw ?? selectOptions[0];

  const view: View = {
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

  return view;
}
