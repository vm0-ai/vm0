<p align="center">
  <img src="https://github.com/vm0-ai/vm0/blob/main/turbo/apps/web/public/assets/Logo_VM0_combo_black_bg.svg" alt="VM0 Logo" width="120" />
</p>

<p align="center">
  <a href="https://deepwiki.com/vm0-ai/vm0">
    <img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" />
  </a>
  <img src="https://img.shields.io/npm/types/@vm0/cli" alt="NPM Type Definitions" />
  <img src="https://img.shields.io/npm/v/@vm0/cli" alt="NPM Version" />
  <img src="https://img.shields.io/bundlejs/size/@vm0/cli" alt="Bundle Size" />
  <a href="https://github.com/vm0-ai/vm0/actions/workflows/turbo.yml">
    <img src="https://github.com/vm0-ai/vm0/actions/workflows/turbo.yml/badge.svg" alt="CI" />
  </a>
</p>

<p align="center">
  <strong>The modern runtime for agent-native development</strong>
</p>

<p align="center">
  <a href="https://www.vm0.ai">Website</a> •
  <a href="https://www.vm0.ai/sign-up">Join Waitlist</a> •
  <a href="https://discord.gg/WMpAmHFfp6">Discord</a> •
  <a href="mailto:ethan@vm0.ai">Contact</a>
</p>

---

## What is VM0?

VM0 is an agent runtime that provides:
- **Cloud security sandbox** - Isolated execution environment for agents
- **Versioned storage** - Volumes and artifacts are version-tracked and recoverable
- **Persistent and reproducible** - Each run creates a checkpoint to resume, fork, and optimize agent performance
- **Full observability** - Agent run logs, sandbox metrics, and network monitoring

Build and extend agents with:
- **Natural language workflows** - Define agent instructions in plain text, no more complex canvas or nodes to maintain
- **Pluggable skills** - Extend capabilities with ready-to-use [agent skills](https://github.com/vm0-ai/vm0-skills)

**Supported agents:**
- Claude Code
- OpenAI Codex (in beta)
- Gemini CLI (coming soon)
- More coming soon...

## Installation

```bash
npm install -g @vm0/cli
```

> VM0 is in beta. [Join the waitlist](https://www.vm0.ai/sign-up) to get access.

## Quick Start

```bash
# 1. Login
vm0 auth login

# 2. Create project directory
mkdir my-agent && cd my-agent

# 3. Initialize project
vm0 init

# 4. Get Claude Code token and save to .env
claude setup-token
echo "CLAUDE_CODE_OAUTH_TOKEN=<your-token>" > .env

# 5. Run your agent
vm0 cook "let's start working."
# Agent follows AGENTS.md: curates AI news from HackerNews and writes to content.md
```

### What just happened?

- `vm0 init` created `vm0.yaml` (agent config) and `AGENTS.md` (agent instructions)
- `vm0 cook` initialized storage, composed the agent, and ran your prompt
- Results are in the `artifact/` directory

### Next steps

- Edit `AGENTS.md` to customize agent instructions
- Edit `vm0.yaml` to configure [agent skills](https://github.com/vm0-ai/vm0-skills)

> For more examples, see [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks).

## CLI Reference

Use `vm0 --help` or `vm0 <command> --help` for detailed usage information.

### Authentication

| Command | Description |
|---------|-------------|
| `vm0 auth login` | Login to VM0 |
| `vm0 auth logout` | Logout from VM0 |
| `vm0 auth status` | Check authentication status |
| `vm0 auth setup-token` | Output auth token for CI/CD environments |

### Tutorial Commands

| Command | Description |
|---------|-------------|
| `vm0 init` | Initialize a new project (creates vm0.yaml + AGENTS.md) |
| `vm0 cook "<prompt>"` | One-click setup and run |
| `vm0 cook continue "<prompt>"` | Continue from last session |
| `vm0 cook resume "<prompt>"` | Resume from last checkpoint |
| `vm0 cook logs` | View logs from last run |

### Agent Commands

| Command | Description |
|---------|-------------|
| `vm0 compose <config.yaml>` | Create/update agent from config |
| `vm0 run <agent> "<prompt>"` | Run agent with prompt |
| `vm0 run continue <session-id> "<prompt>"` | Continue from session |
| `vm0 run resume <checkpoint-id> "<prompt>"` | Resume from checkpoint |
| `vm0 logs <run-id>` | View run logs |

### Storage Commands

| Command | Description |
|---------|-------------|
| `vm0 artifact init` | Initialize artifact in current directory |
| `vm0 artifact push` | Upload artifact to cloud |
| `vm0 artifact pull [version]` | Download artifact from cloud |
| `vm0 volume init` | Initialize volume in current directory |
| `vm0 volume push` | Upload volume to cloud |
| `vm0 volume pull [version]` | Download volume from cloud |

## Concepts

| Concept | Description |
|---------|-------------|
| **Agent** | Runs in sandbox with filesystem, mounts volumes and artifact |
| **Volume** | Mounts agent instructions, skills, and datasets (read-only) |
| **Artifact** | Versioned workspace where agents read/write files |
| **Checkpoint** | Immutable snapshot of run state (artifact, volumes, conversation) |
| **Session** | Continue conversation with latest artifact version |

## Resources

- [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks) - Ready-to-run examples
- [vm0-skills](https://github.com/vm0-ai/vm0-skills) - Agent skills library
- [Contributing guide](./CONTRIBUTING.md) - Development setup
- [Website](https://www.vm0.ai) - Official website
- [Discord](https://discord.gg/WMpAmHFfp6) - Join our community
- [Email](mailto:ethan@vm0.ai) - Questions and support

## License

See [LICENSE](./LICENSE) for details.
