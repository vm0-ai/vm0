# Slack Bot for VM0 Agent Run & Continue

## Summary

Enable users to trigger VM0 agent runs and continues through @bot mentions in Slack. Users connect their Slack workspace via OAuth, then create bots that bind to their agents.

## Motivation

Users want to interact with their VM0 agents directly from Slack without leaving their communication workflow. The setup should be as simple as possible - no manual Slack App creation required.

## User Stories

1. As a user, I want to connect my Slack workspace to VM0 with a simple OAuth flow
2. As a user, I want to create a Slack bot that binds to one of my agents
3. As a user, I want to @bot in a Slack channel to start a new agent run
4. As a user, I want to continue a conversation by replying in a Slack thread
5. As a user, I want to see the agent's result as a reply in the thread

## Detailed Design

### Architecture: VM0-Hosted Slack App

VM0 hosts a single Slack App that all users install to their workspaces. This eliminates the need for users to create and configure their own Slack Apps.

**Key characteristics**:
- Users do OAuth authorization, not Slack App creation
- VM0 receives events for all connected workspaces (multi-tenant)
- Events are routed to the correct user's bot based on workspace ID

### User Flow

#### Step 1: Connect Slack Workspace

```bash
$ vm0 slack connect

Connecting to Slack...
Opening browser for authorization...

Please authorize VM0 in your Slack workspace.

Waiting for authorization.....

✓ Slack workspace connected: "Acme Corp"
  Workspace ID: T12345ABC
```

#### Step 2: Create Bot from Agent

```bash
$ vm0 slack bot create my-agent

Creating Slack bot for agent "my-agent"...

? Select workspace: Acme Corp (T12345ABC)

Agent requires the following secrets:
? OPENAI_API_KEY: sk-...

✓ Slack bot created!
  You can now @VM0 in Acme Corp to trigger "my-agent"
```

#### Step 3: Use in Slack

```
User: @VM0 analyze this quarter's sales data

VM0: [thinking...]

VM0: Based on my analysis of Q4 sales data:
     - Revenue increased 15% QoQ
     - Top performing region: APAC
     ...
```

### Core Concepts

#### Thread-to-Session Mapping
- Main message @bot → Creates new VM0 session
- Thread reply @bot → Continues existing session
- Use Slack's `thread_ts` to distinguish between new runs and continues

#### Permission Model (MVP: Creator-Only)

**Security Constraint**: Only the user who connected the workspace can trigger the bot.

Rationale:
- VM0-hosted app means VM0 controls who triggers
- Allowing anyone would expose creator's secrets
- Check Slack user ID against workspace connection owner

Future expansion options:
- Allowlist: Configure additional Slack user IDs
- VM0 account linking: Slack users link their VM0 accounts

#### Secrets Management

Follow the Schedule pattern:
- Store encrypted secrets at bot configuration time
- Decrypt at runtime for each run
- Use `SECRETS_ENCRYPTION_KEY` with AES-256-GCM

### Data Model

#### New Table: `slack_workspace_connections`

Stores OAuth tokens for connected Slack workspaces.

```sql
CREATE TABLE slack_workspace_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                      -- VM0 user (Clerk ID)
  slack_workspace_id VARCHAR(64) NOT NULL,    -- Slack team_id
  slack_workspace_name VARCHAR(255),
  slack_bot_token TEXT NOT NULL,              -- Encrypted xoxb-* token
  slack_bot_user_id VARCHAR(64),              -- Bot's user ID in Slack
  slack_installer_user_id VARCHAR(64),        -- Slack user who installed
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(user_id, slack_workspace_id)
);
```

#### New Table: `slack_bots`

Links agents to Slack workspaces with runtime configuration.

```sql
CREATE TABLE slack_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  workspace_connection_id UUID NOT NULL REFERENCES slack_workspace_connections(id) ON DELETE CASCADE,
  compose_id UUID NOT NULL REFERENCES agent_composes(id) ON DELETE CASCADE,

  -- Agent runtime configuration
  encrypted_secrets TEXT,
  vars JSONB,
  artifact_name VARCHAR(255),
  volume_versions JSONB,

  -- State
  enabled BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL,

  -- One bot per agent per workspace
  UNIQUE(workspace_connection_id, compose_id)
);
```

#### New Table: `slack_thread_sessions`

Maps Slack threads to VM0 sessions for continue operations.

```sql
CREATE TABLE slack_thread_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_bot_id UUID NOT NULL REFERENCES slack_bots(id) ON DELETE CASCADE,
  slack_channel_id VARCHAR(64) NOT NULL,
  slack_thread_ts VARCHAR(64) NOT NULL,
  agent_session_id UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,

  UNIQUE(slack_bot_id, slack_channel_id, slack_thread_ts)
);
```

#### New Table: `slack_oauth_sessions`

Temporary storage for OAuth flow (like device_codes for CLI auth).

```sql
CREATE TABLE slack_oauth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token VARCHAR(255) NOT NULL UNIQUE,  -- Random token for CLI polling
  user_id TEXT NOT NULL,                        -- VM0 user initiating OAuth
  status VARCHAR(32) DEFAULT 'pending',         -- pending | completed | failed
  slack_workspace_id VARCHAR(64),               -- Filled after OAuth
  slack_workspace_name VARCHAR(255),
  slack_bot_token TEXT,                         -- Encrypted, filled after OAuth
  error TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
```

### API Endpoints

#### Slack OAuth (CLI Flow)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/cli/slack/connect` | Initiate OAuth, return auth_url + session_token |
| GET | `/api/cli/slack/connect/status` | Poll for OAuth completion |
| GET | `/api/slack/oauth/callback` | Slack OAuth redirect handler |

#### Slack Workspace Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agent/slack/workspaces` | List connected workspaces |
| DELETE | `/api/agent/slack/workspaces/[id]` | Disconnect workspace |

#### Slack Bot Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/slack/bots` | Create bot |
| GET | `/api/agent/slack/bots` | List bots |
| DELETE | `/api/agent/slack/bots/[id]` | Delete bot |

#### Slack Webhook (from Slack)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/slack/events` | Receive Slack events |

### CLI Commands

```bash
# Connect Slack workspace (opens browser for OAuth)
vm0 slack connect

# List connected workspaces
vm0 slack workspaces

# Disconnect workspace
vm0 slack disconnect <workspace-name>

# Create bot from agent
vm0 slack bot create <agent-name> [--workspace <name>] [--secrets KEY=value]

# List bots
vm0 slack bot list

# Delete bot
vm0 slack bot delete <agent-name> [--workspace <name>]
```

### OAuth Flow Detail

```
CLI                          VM0 Server                    Slack
 │                               │                           │
 │ POST /api/cli/slack/connect   │                           │
 │ ─────────────────────────────►│                           │
 │                               │                           │
 │ { session_token, auth_url }   │                           │
 │ ◄─────────────────────────────│                           │
 │                               │                           │
 │ [Open browser to auth_url]    │                           │
 │ ═══════════════════════════════════════════════════════► │
 │                               │                           │
 │                               │    User clicks "Allow"    │
 │                               │ ◄═══════════════════════ │
 │                               │                           │
 │                               │ GET /callback?code=xxx    │
 │                               │ ◄═════════════════════════│
 │                               │                           │
 │                               │ POST oauth.v2.access      │
 │                               │ ═════════════════════════►│
 │                               │                           │
 │                               │ { bot_token, team_id }    │
 │                               │ ◄═════════════════════════│
 │                               │                           │
 │                               │ [Store in oauth_sessions] │
 │                               │                           │
 │ GET /api/cli/slack/connect/status                         │
 │ ─────────────────────────────►│                           │
 │                               │                           │
 │ { status: "completed", workspace_name }                   │
 │ ◄─────────────────────────────│                           │
```

### Webhook Processing Flow

```
1. POST /api/webhooks/slack/events
   {
     "team_id": "T12345",
     "event": { "type": "app_mention", "user": "U67890", ... }
   }
   ↓
2. Respond HTTP 200 immediately (Slack 3-second requirement)
   ↓
3. Async processing:
   a. Find workspace_connection by team_id
   b. Find slack_bot by workspace_connection_id
   c. Verify trigger permission:
      - event.user == workspace_connection.slack_installer_user_id?
   d. Check thread_ts for new vs continue
   ↓
4. Create/continue run with bot's secrets
   ↓
5. Wait for completion
   ↓
6. Post result to Slack thread via chat.postMessage
```

## Technical Constraints

### Slack API Requirements

1. **3-second response**: Must acknowledge webhook within 3 seconds
2. **OAuth scopes needed**: `app_mentions:read`, `chat:write`
3. **Event subscription**: `app_mention` event

### VM0 Slack App Setup (One-time)

VM0 needs to register a Slack App at api.slack.com:

| Setting | Value |
|---------|-------|
| App Name | VM0 Agent |
| OAuth Redirect URL | `https://api.vm0.ai/api/slack/oauth/callback` |
| Bot Token Scopes | `app_mentions:read`, `chat:write` |
| Event Request URL | `https://api.vm0.ai/api/webhooks/slack/events` |
| Subscribe to events | `app_mention` |

### Multi-tenant Considerations

- Single Slack App serves all VM0 users
- Events routed by `team_id` to correct user's bot
- All bots appear as "@VM0 Agent" in Slack (single app identity)

## Security Considerations

1. **Trigger permission**: Only workspace connection owner can @bot (MVP)
2. **Secret storage**: AES-256-GCM encryption for bot tokens and agent secrets
3. **OAuth state**: Use session_token as state parameter to prevent CSRF
4. **Token refresh**: Handle token expiration (Slack tokens generally don't expire)

## Out of Scope (Future)

1. Allowlist-based trigger permissions
2. VM0 account linking for Slack users
3. Per-user secrets
4. Custom bot names per workspace
5. Streaming responses to Slack

## Dependencies

- Existing: `schedule-service.ts` pattern for encrypted secrets
- Existing: `agent-session-service.ts` for session management
- Existing: `run-service.ts` for run orchestration
- Existing: CLI auth device code pattern for OAuth polling
- New: Slack Web API client for posting messages

## References

- [Slack OAuth 2.0](https://api.slack.com/authentication/oauth-v2)
- [Slack Events API](https://api.slack.com/apis/events-api)
- Research document: `/tmp/deep-dive/slack-vm0-agent-bot/research.md`
- Innovate document: `/tmp/deep-dive/slack-vm0-agent-bot/innovate/create-slack-bot-flow.md`
