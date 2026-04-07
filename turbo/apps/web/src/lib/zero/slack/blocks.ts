import type {
  Block,
  KnownBlock,
  View,
  ActionsBlock,
  Button,
  Checkboxes,
  MarkdownBlock,
  Option,
} from "@slack/web-api";
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
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":robot_face: *Workspace Agent*",
    },
  });

  if (options.agentName) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `AgentName: *${options.agentName}*`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Settings" },
        url: `${getAppUrl()}/works`,
        action_id: "home_environment_setup",
      },
    });
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
 * @returns Block Kit blocks
 */
export function buildHelpMessage(): (Block | KnownBlock)[] {
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
        text: `*Commands*\n\u2022 \`/zero connect\` - Connect to Zero\n\u2022 \`/zero disconnect\` - Disconnect from Zero`,
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
 * Build an agent response message with optional logs link
 *
 * @param content - The agent's response content
 * @param logsUrl - Optional URL to the run logs
 * @param triggeredBy - Optional attribution text shown as a separate context block below a divider
 * @returns Block Kit blocks with response content
 */
export function buildAgentResponseMessage(
  content: string,
  logsUrl?: string,
  triggeredBy?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [...buildMarkdownMessage(content)];

  // Add logs link at the end if provided
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

  if (triggeredBy) {
    blocks.push(...buildFooterBlocks(triggeredBy));
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

/**
 * Build a message prompting user to login
 *
 * @param loginUrl - URL to the OAuth login page
 * @returns Block Kit blocks
 */
// ---------------------------------------------------------------------------
// askUserQuestion interactive cards
// ---------------------------------------------------------------------------

/**
 * Question shape from AskUserQuestion tool_input
 */
export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * Build Block Kit blocks for an askUserQuestion interactive card.
 *
 * - Single-select questions render as buttons (one per option).
 * - Multi-select questions render as checkboxes with a submit button.
 * - When there are multiple questions, a "Submit" button is appended
 *   so the user can confirm all selections at once.
 *
 * @param questions - The questions array from AskUserQuestion denial
 * @param pendingId - The slack_pending_questions record ID (used as button value)
 * @returns Block Kit blocks
 */
export function buildAskUserQuestionBlocks(
  questions: AskUserQuestion[],
  pendingId: string,
): (Block | KnownBlock)[] {
  // Slack enforces max 50 blocks per message and 25 elements per actions block.
  // Cap questions and options to stay well within limits.
  const MAX_QUESTIONS = 10;
  const MAX_OPTIONS = 10;
  const cappedQuestions = questions.slice(0, MAX_QUESTIONS).map((q) => {
    return {
      ...q,
      options: q.options?.slice(0, MAX_OPTIONS),
    };
  });

  // Single question + single-select → buttons submit directly on click
  const directSubmit =
    cappedQuestions.length === 1 &&
    !cappedQuestions[0]?.multiSelect &&
    cappedQuestions[0]?.options &&
    cappedQuestions[0].options.length > 0;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":raising_hand: *The agent needs your input to proceed:*",
      },
    },
  ];

  for (let qIdx = 0; qIdx < cappedQuestions.length; qIdx++) {
    const q = cappedQuestions[qIdx]!;
    const headerText = q.header ? `*${q.header}:* ` : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headerText}${q.question}`,
      },
    });

    if (!q.options || q.options.length === 0) {
      continue;
    }

    const options: Option[] = q.options.map((opt, oIdx) => {
      return {
        text: { type: "plain_text" as const, text: opt.label },
        description: opt.description
          ? { type: "plain_text" as const, text: opt.description }
          : undefined,
        value: `q${qIdx}_o${oIdx}`,
      };
    });

    if (directSubmit) {
      // Single question + single-select: buttons that submit on click
      const buttons: Button[] = q.options.map((opt, oIdx) => {
        return {
          type: "button" as const,
          text: { type: "plain_text" as const, text: opt.label },
          action_id: `ask_user_pick_q${qIdx}_o${oIdx}`,
          value: pendingId,
        };
      });

      blocks.push({
        type: "actions",
        block_id: `ask_user_block_q${qIdx}`,
        elements: buttons,
      } as ActionsBlock);
    } else {
      // Checkboxes for multi-question or multi-select flows
      const checkboxes: Checkboxes = {
        type: "checkboxes",
        action_id: `ask_user_multi_q${qIdx}`,
        options,
      };

      blocks.push({
        type: "actions",
        block_id: `ask_user_block_q${qIdx}`,
        elements: [checkboxes],
      } as ActionsBlock);
    }
  }

  if (!directSubmit) {
    // Submit button for multi-question or multi-select flows
    const submitButton: Button = {
      type: "button",
      text: { type: "plain_text", text: "Submit" },
      action_id: "ask_user_submit",
      value: pendingId,
      style: "primary",
    };

    blocks.push({
      type: "actions",
      block_id: "ask_user_submit_block",
      elements: [submitButton],
    } as ActionsBlock);

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "_Select your answers above, then click Submit to continue._",
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks showing the user's answers after submission.
 * Replaces the interactive card once the user clicks Submit.
 */
export function buildAskUserAnsweredBlocks(
  questions: AskUserQuestion[],
  answers: Map<number, string[]>,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:white_check_mark: *Answered*`,
        },
      ],
    },
  ];

  for (let qIdx = 0; qIdx < questions.length; qIdx++) {
    const q = questions[qIdx]!;
    const selected = answers.get(qIdx) ?? [];
    const headerText = q.header ? `*${q.header}:* ` : "";
    const selectedText =
      selected.length > 0 ? selected.join(", ") : "_No selection_";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headerText}${q.question}\n:arrow_right: ${selectedText}`,
      },
    });
  }

  return blocks;
}

export function buildLoginMessage(loginUrl: string): (Block | KnownBlock)[] {
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
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "login",
          style: "primary",
        },
      ],
    },
  ];
}
