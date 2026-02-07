import type {
  Block,
  InputBlock,
  KnownBlock,
  View,
  SectionBlock,
} from "@slack/web-api";

interface AgentOption {
  id: string;
  name: string;
  requiredSecrets: string[];
  existingSecrets: string[];
  requiredVars: string[];
  existingVars: string[];
}

interface BindingInfo {
  id: string;
  agentName: string;
  description: string | null;
  enabled: boolean;
}

/**
 * Build an input block for a variable or secret value
 * Used by both add and update modals
 */
function buildValueInputBlock(
  blockIdPrefix: string,
  name: string,
  isExisting: boolean,
  isRequired: boolean,
): InputBlock {
  const isOptional = !isRequired || isExisting;
  return {
    type: "input",
    block_id: `${blockIdPrefix}_${name}`,
    ...(isOptional && { optional: true }),
    element: {
      type: "plain_text_input",
      action_id: "value",
      placeholder: {
        type: "plain_text",
        text: isExisting
          ? "Leave empty to keep current value"
          : `Enter value for ${name}`,
      },
    },
    label: {
      type: "plain_text",
      text: isExisting ? `${name} ✓` : name,
    },
    ...(isExisting && {
      hint: {
        type: "plain_text",
        text: "Already configured in your account",
      },
    }),
  };
}

/**
 * Build blocks for the "existing agent" mode in the add modal
 */
function buildExistingAgentBlocks(
  agents: AgentOption[],
  selectedAgentId?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [];
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : undefined;

  blocks.push({
    type: "input",
    block_id: "agent_select",
    dispatch_action: true,
    element: {
      type: "static_select",
      action_id: "agent_select_action",
      placeholder: {
        type: "plain_text",
        text: "Select an agent",
      },
      options: agents.map((agent) => ({
        text: {
          type: "plain_text" as const,
          text: agent.name,
        },
        value: agent.id,
      })),
      ...(selectedAgentId && {
        initial_option: {
          text: {
            type: "plain_text" as const,
            text: selectedAgent?.name ?? "",
          },
          value: selectedAgentId,
        },
      }),
    },
    label: {
      type: "plain_text",
      text: "Agent",
    },
  });

  if (selectedAgent) {
    blocks.push({
      type: "input",
      block_id: "agent_description",
      optional: true,
      element: {
        type: "plain_text_input",
        action_id: "description_input",
        placeholder: {
          type: "plain_text",
          text: "e.g., Helps with code reviews and bug fixes",
        },
      },
      label: {
        type: "plain_text",
        text: "Description",
      },
      hint: {
        type: "plain_text",
        text: "Helps route messages to the right agent when you have multiple agents",
      },
    });
  }

  if (selectedAgent && selectedAgent.requiredVars.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Variables*" },
    });

    const existingVarsSet = new Set(selectedAgent.existingVars);
    for (const varName of selectedAgent.requiredVars) {
      blocks.push(
        buildValueInputBlock(
          "var",
          varName,
          existingVarsSet.has(varName),
          true,
        ),
      );
    }
  }

  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Secrets*" },
    });

    const existingSecretsSet = new Set(selectedAgent.existingSecrets);
    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push(
        buildValueInputBlock(
          "secret",
          secretName,
          existingSecretsSet.has(secretName),
          true,
        ),
      );
    }
  }

  if (
    selectedAgent &&
    selectedAgent.requiredVars.length === 0 &&
    selectedAgent.requiredSecrets.length === 0
  ) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't require any variables or secrets._",
      },
    });
  } else if (!selectedAgent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to see required configuration._",
      },
    });
  }

  return blocks;
}

/**
 * Build blocks for the "GitHub URL" mode in the add modal
 */
function buildGithubUrlBlocks(hasAgents: boolean): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [];

  if (!hasAgents) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "You don't have any agents yet. Enter a GitHub URL to compose one.",
        },
      ],
    });
  }

  blocks.push({
    type: "input",
    block_id: "github_url_input",
    element: {
      type: "plain_text_input",
      action_id: "github_url_value",
      placeholder: {
        type: "plain_text",
        text: "https://github.com/owner/repo",
      },
    },
    label: {
      type: "plain_text",
      text: "GitHub URL",
    },
    hint: {
      type: "plain_text",
      text: "The repository must contain a vm0.yaml file",
    },
  });

  return blocks;
}

/**
 * Build the "Add Agent" modal view
 *
 * Supports two modes:
 * - "existing": Select from existing agents (default when agents are available)
 * - "github": Enter a GitHub URL to compose a new agent
 *
 * @param agents - List of available agents
 * @param selectedAgentId - Currently selected agent ID
 * @param channelId - Channel ID to send confirmation message to
 * @param mode - Which mode to display ("existing" or "github")
 * @returns Modal view definition
 */
export function buildAgentAddModal(
  agents: AgentOption[],
  selectedAgentId?: string,
  channelId?: string,
  mode?: "existing" | "github",
): View {
  const hasAgents = agents.length > 0;
  const effectiveMode = mode ?? (hasAgents ? "existing" : "github");

  const blocks: (Block | KnownBlock)[] = [];

  // Show mode selector only when user has existing agents
  if (hasAgents) {
    blocks.push({
      type: "actions",
      block_id: "link_mode_select",
      elements: [
        {
          type: "radio_buttons",
          action_id: "link_mode_action",
          options: [
            {
              text: { type: "plain_text", text: "Select existing agent" },
              value: "existing",
            },
            {
              text: { type: "plain_text", text: "Compose from GitHub URL" },
              value: "github",
            },
          ],
          initial_option: {
            text: {
              type: "plain_text",
              text:
                effectiveMode === "existing"
                  ? "Select existing agent"
                  : "Compose from GitHub URL",
            },
            value: effectiveMode,
          },
        },
      ],
    });
    blocks.push({ type: "divider" });
  }

  if (effectiveMode === "github") {
    blocks.push(...buildGithubUrlBlocks(hasAgents));
  } else {
    blocks.push(...buildExistingAgentBlocks(agents, selectedAgentId));
  }

  return {
    type: "modal",
    callback_id: "agent_add_modal",
    private_metadata: JSON.stringify({ channelId, mode: effectiveMode }),
    title: {
      type: "plain_text",
      text: effectiveMode === "github" ? "Compose Agent" : "Add Agent",
    },
    submit: {
      type: "plain_text",
      text: effectiveMode === "github" ? "Compose" : "Add",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks,
  };
}

/**
 * Build the App Home tab view
 *
 * @param options - Configuration for the home view
 * @returns View definition for the Home tab
 */
export function buildAppHomeView(options: {
  isLinked: boolean;
  vm0UserId?: string;
  bindings?: BindingInfo[];
  loginUrl?: string;
}): View {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Welcome to VM0! :wave:",
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

  // Account status
  if (options.isLinked) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Connected to VM0*\nAccount: ${options.vm0UserId}`,
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

  // Linked agents
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":robot_face: *Your Linked Agent*",
    },
  });

  if (options.bindings && options.bindings.length > 0) {
    for (const binding of options.bindings) {
      let agentText = `AgentName: *${binding.agentName}*`;
      if (binding.description) {
        agentText += `\nDescription: ${binding.description}`;
      }
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: agentText,
        },
      });

      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Update" },
            action_id: "home_agent_update",
            value: binding.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Unlink" },
            action_id: "home_agent_unlink",
            value: binding.id,
            style: "danger",
          },
        ],
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No agent linked yet._",
      },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Link Agent" },
          action_id: "home_agent_link",
          style: "primary",
        },
      ],
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
      text: "*Chat with your agents*\nSend a DM or `@VM0` in any channel\n`@VM0 [your message]`",
    },
  });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Link and manage agents*\nLink an agent\n`/vm0 agent link`\nUnlink an agent\n`/vm0 agent unlink`\nUpdate agent configuration\n`/vm0 agent update`",
    },
  });

  blocks.push({ type: "divider" });

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "*Disconnect VM0 Account*\nThis will remove your VM0 account connection",
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
        title: { type: "plain_text", text: "Disconnect VM0 Account" },
        text: {
          type: "plain_text",
          text: "This will remove your VM0 account connection",
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

interface AgentBinding {
  id: string;
  agentName: string;
}

interface AgentUpdateOption {
  id: string;
  name: string;
  description: string | null;
  requiredSecrets: string[];
  existingSecrets: string[];
  requiredVars: string[];
  existingVars: string[];
}

/**
 * Build the "Update Agent" modal view
 *
 * @param agents - List of bound agents with their required secrets
 * @param selectedAgentId - Currently selected agent ID
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentUpdateModal(
  agents: AgentUpdateOption[],
  selectedAgentId?: string,
  channelId?: string,
): View {
  // Find selected agent or default to first
  const selectedAgent = selectedAgentId
    ? agents.find((a) => a.id === selectedAgentId)
    : undefined;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "input",
      block_id: "agent_select",
      dispatch_action: true,
      element: {
        type: "static_select",
        action_id: "agent_update_select_action",
        placeholder: {
          type: "plain_text",
          text: "Select an agent to update",
        },
        options: agents.map((agent) => ({
          text: {
            type: "plain_text" as const,
            text: agent.name,
          },
          value: agent.id,
        })),
        ...(selectedAgentId && {
          initial_option: {
            text: {
              type: "plain_text" as const,
              text: selectedAgent?.name ?? "",
            },
            value: selectedAgentId,
          },
        }),
      },
      label: {
        type: "plain_text",
        text: "Agent",
      },
    },
  ];

  // Add description field only after agent is selected
  if (selectedAgent) {
    blocks.push({
      type: "input",
      block_id: "agent_description",
      optional: true,
      element: {
        type: "plain_text_input",
        action_id: "description_input",
        placeholder: {
          type: "plain_text",
          text: "e.g., Helps with code reviews and bug fixes",
        },
        ...(selectedAgent.description && {
          initial_value: selectedAgent.description,
        }),
      },
      label: {
        type: "plain_text",
        text: "Description",
      },
      hint: {
        type: "plain_text",
        text: "Helps route messages to the right agent when you have multiple agents",
      },
    });
  }

  // Add variables fields if agent is selected and has required vars
  if (selectedAgent && selectedAgent.requiredVars.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Update Variables*\n_Leave empty to keep current value_",
      },
    });

    const existingVarsSet = new Set(selectedAgent.existingVars);
    for (const varName of selectedAgent.requiredVars) {
      blocks.push(
        buildValueInputBlock(
          "var",
          varName,
          existingVarsSet.has(varName),
          false,
        ),
      );
    }
  }

  // Add secrets fields if agent is selected and has required secrets
  if (selectedAgent && selectedAgent.requiredSecrets.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Update Secrets*\n_Leave empty to keep current value_",
      },
    });

    const existingSecretsSet = new Set(selectedAgent.existingSecrets);
    for (const secretName of selectedAgent.requiredSecrets) {
      blocks.push(
        buildValueInputBlock(
          "secret",
          secretName,
          existingSecretsSet.has(secretName),
          false,
        ),
      );
    }
  }

  // Show message if no variables or secrets to update
  if (
    selectedAgent &&
    selectedAgent.requiredVars.length === 0 &&
    selectedAgent.requiredSecrets.length === 0
  ) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_This agent doesn't have any variables or secrets to update._",
      },
    });
  } else if (!selectedAgent) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Select an agent to update its configuration._",
      },
    });
  }

  return {
    type: "modal",
    callback_id: "agent_update_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Update Agent",
    },
    submit: selectedAgent
      ? {
          type: "plain_text",
          text: "Update",
        }
      : undefined,
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks,
  };
}

/**
 * Build the "Remove Agent" modal view with multi-select
 *
 * @param agents - List of bound agents
 * @param channelId - Channel ID to send confirmation message to
 * @returns Modal view definition
 */
export function buildAgentRemoveModal(
  agents: AgentBinding[],
  channelId?: string,
): View {
  return {
    type: "modal",
    callback_id: "agent_remove_modal",
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: "plain_text",
      text: "Remove Agents",
    },
    submit: {
      type: "plain_text",
      text: "Remove",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "agents_select",
        element: {
          type: "multi_static_select",
          action_id: "agents_select_action",
          placeholder: {
            type: "plain_text",
            text: "Select agents to remove",
          },
          options: agents.map((agent) => ({
            text: {
              type: "plain_text" as const,
              text: agent.agentName,
            },
            value: agent.id,
          })),
        },
        label: {
          type: "plain_text",
          text: "Select agents to remove",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: ":warning: This action cannot be undone.",
          },
        ],
      },
    ],
  };
}

/**
 * Build a message listing bound agents
 *
 * @param bindings - List of agent bindings
 * @returns Block Kit blocks
 */
export function buildAgentListMessage(
  bindings: BindingInfo[],
): (Block | KnownBlock)[] {
  if (bindings.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "You don't have any agent linked yet.\n\nUse `/vm0 agent link` to link one.",
        },
      },
    ];
  }

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":robot_face: *Your Linked Agent*",
      },
    },
    {
      type: "divider",
    },
  ];

  for (const binding of bindings) {
    const status = binding.enabled ? ":white_check_mark:" : ":x:";
    const description = binding.description ?? "_No description_";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${status} *${binding.agentName}*\n${description}`,
      },
    });
  }

  return blocks;
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
        text: "To use VM0 in Slack, please connect your account first.",
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

interface WelcomeAgentInfo {
  agentName: string;
  description: string | null;
}

/**
 * Build a welcome message for non-agent requests (greetings, casual chat)
 * Explains what VM0 can do and lists available agents
 *
 * @param agents - User's available agents
 * @returns Block Kit blocks
 */
export function buildWelcomeMessage(
  agents: WelcomeAgentInfo[],
): (Block | KnownBlock)[] {
  const hasAgents = agents.length > 0;

  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":wave: *Hi! I'm VM0.*\n\nI can connect you to AI agents to help with your tasks.",
      },
    },
    {
      type: "divider",
    },
  ];

  if (hasAgents) {
    const agentList = agents
      .map((a) => `• \`${a.agentName}\`: ${a.description ?? "No description"}`)
      .join("\n");

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Your Linked Agent*\n${agentList}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n• Just describe what you need help with",
        },
      },
    );
  } else {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Your Linked Agent*\n_No agent linked yet._ Use the button below to link one.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Link Agent",
            },
            action_id: "home_agent_link",
            style: "primary",
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n• Link an agent first, then describe what you need help with",
        },
      },
    );
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
        text: "*VM0 Slack Bot Help*",
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Account*\n• `/vm0 connect` - Connect to VM0\n• `/vm0 disconnect` - Disconnect from VM0",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Agent*\n• `/vm0 agent link` - Link an agent or compose from GitHub URL\n• `/vm0 agent unlink` - Unlink your agent\n• `/vm0 agent update` - Update agent configuration",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Usage*\n• `@VM0 <message>` - Send a message to your agent",
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
 * Build markdown message blocks
 * Splits long content into multiple section blocks (Slack limit: 3000 chars per block)
 *
 * @param content - Markdown content
 * @returns Block Kit blocks
 */
/**
 * Convert standard Markdown to Slack mrkdwn format
 */
function convertToSlackMarkdown(content: string): string {
  let result = content;

  // Convert headers (## Header -> *Header*)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert bold (**text** -> *text*)
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert links [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert inline code (already works in Slack)
  // `code` stays as `code`

  // Convert horizontal rules (--- or ***) to divider-like text
  result = result.replace(/^[-*]{3,}$/gm, "───────────────");

  return result;
}

export function buildMarkdownMessage(content: string): (Block | KnownBlock)[] {
  const MAX_BLOCK_LENGTH = 2900; // Leave some margin below 3000
  const blocks: SectionBlock[] = [];

  // Convert standard Markdown to Slack mrkdwn
  const slackContent = convertToSlackMarkdown(content);

  // Split content into chunks if too long
  let remaining = slackContent;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_BLOCK_LENGTH) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: remaining,
        },
      });
      break;
    }

    // Find a good split point (newline or space)
    let splitIndex = remaining.lastIndexOf("\n", MAX_BLOCK_LENGTH);
    if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf(" ", MAX_BLOCK_LENGTH);
    }
    if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
      splitIndex = MAX_BLOCK_LENGTH;
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: remaining.substring(0, splitIndex),
      },
    });
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return blocks;
}

/**
 * Build an agent response message with agent name context and optional logs link
 *
 * @param content - The agent's response content
 * @param agentName - The name of the agent that responded
 * @param logsUrl - Optional URL to the run logs
 * @returns Block Kit blocks with agent context header
 */
export function buildAgentResponseMessage(
  content: string,
  agentName: string,
  logsUrl?: string,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:robot_face: *${agentName}*`,
        },
      ],
    },
    ...buildMarkdownMessage(content),
  ];

  // Add logs link at the end if provided
  if (logsUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${logsUrl}|:clipboard: View logs>`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build a message prompting user to login
 *
 * @param loginUrl - URL to the OAuth login page
 * @returns Block Kit blocks
 */
export function buildLoginMessage(loginUrl: string): (Block | KnownBlock)[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Please connect your account to use VM0 in this workspace.",
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
