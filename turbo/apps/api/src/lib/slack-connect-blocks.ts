import type { Block, KnownBlock, View } from "@slack/web-api";

interface AppHomeViewOptions {
  readonly appUrl: string;
  readonly isLinked: boolean;
  readonly vm0UserId?: string;
  readonly userEmail?: string;
  readonly agentName?: string;
  readonly isOverrideActive?: boolean;
  readonly canSwitch?: boolean;
  readonly loginUrl?: string;
}

function appHomeIntroBlocks(): (Block | KnownBlock)[] {
  return [
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
}

function disconnectedAppHomeBlocks(
  loginUrl: string | undefined,
): (Block | KnownBlock)[] {
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":x: *Account not connected*",
      },
    },
  ];
  if (loginUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "home_login_prompt",
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

function connectedStatusBlock(options: AppHomeViewOptions): KnownBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:white_check_mark: *Connected to Zero*\nAccount: ${options.userEmail ?? options.vm0UserId}`,
    },
  };
}

function appHomeAgentBlocks(
  options: AppHomeViewOptions,
): (Block | KnownBlock)[] {
  const agentHeading = options.isOverrideActive
    ? ":robot_face: *Your Agent*"
    : ":robot_face: *Workspace Agent*";
  const blocks: (Block | KnownBlock)[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: agentHeading,
      },
    },
  ];

  if (!options.agentName) {
    return [
      ...blocks,
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_No agent configured yet._",
        },
      },
    ];
  }

  const settingsButton = {
    type: "button" as const,
    text: { type: "plain_text" as const, text: "Settings" },
    url: `${options.appUrl}/works`,
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
  return blocks;
}

function appHomeHelpBlocks(): (Block | KnownBlock)[] {
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
  ];
}

function disconnectAccountBlock(): KnownBlock {
  return {
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
  };
}

export function buildAppHomeView(options: AppHomeViewOptions): View {
  const blocks = appHomeIntroBlocks();

  if (!options.isLinked) {
    return {
      type: "home",
      blocks: [...blocks, ...disconnectedAppHomeBlocks(options.loginUrl)],
    };
  }

  blocks.push(
    connectedStatusBlock(options),
    { type: "divider" },
    ...appHomeAgentBlocks(options),
    { type: "divider" },
    ...appHomeHelpBlocks(),
    { type: "divider" },
    disconnectAccountBlock(),
  );

  return {
    type: "home",
    blocks,
  };
}

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
