# VM0

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

AI development today is held back by two outdated models:

- 🧱 **Container runners**: traditional tech stack
- 🔗 **Workflow builders**: rigid, brittle, not agent-native

Agents require a fundamentally different environment.

**VM0 is the runtime purpose-built for agents.**  
No workflows. No black-box containers. Just a clean, persistent, observable place for agents to live, think, and evolve.

---

## Build agents the modern way

### Natural-language powered

Write a prompt or a simple config file, and your agent is ready.  
No drag-and-drop. No pipelines.

### Works with all CLI-based agents

VM0 supports the new wave of developer-native agent CLIs:

- Claude Code
- OpenAI Codex
- Gemini CLI
- Cursor CLI
- Any custom CLI agent

VM0 integrates seamlessly into your development environment.

---

## Installation

```bash
npm install -g @vm0/cli
```

## Quick start

### Fastest way (with cookbooks)

Try a ready-to-use example:

```bash
vm0 auth login

# Clone examples
git clone https://github.com/vm0-ai/vm0-cookbooks.git
cd vm0-cookbooks/101-intro

# Run with auto-setup
vm0 cook "echo hello world to readme.md"
```

The `vm0 cook` command automatically handles volume and artifact setup.

> **Authentication required:** Configure Claude Code and API secrets before running. Check each cookbook's `vm0.yaml` for specific requirements. [Setup guide →](https://github.com/vm0-ai/vm0-cookbooks?tab=readme-ov-file#setup-secrets)

> **More examples:** [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks) has 10+ ready-to-run examples including writing agents, web scrapers, ML trainers, and more.

### From scratch (build your own)

Create your own agent from scratch:

```bash
# 1. Login
vm0 auth login

# 2. Create agent config
cat > vm0.yaml << 'EOF'
version: "1.0"
agents:
  my-agent:
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
    volumes:
      - claude-files:/home/user/.config/claude
volumes:
  claude-files:
    name: claude-files
    version: latest
EOF

# 3. Create volume with CLAUDE.md
mkdir claude-files && cd claude-files
cat > CLAUDE.md << 'EOF'
You are a helpful coding assistant. Create clean, well-documented code.
EOF

vm0 volume init
vm0 volume push
cd ..

# 4. Compose agent
vm0 compose vm0.yaml

# 5. Setup workspace
mkdir workspace && cd workspace
vm0 artifact init

# 6. Run agent
vm0 run my-agent --artifact-name workspace "Create a Python hello world script"

# 7. Get results
vm0 artifact pull
cat hello.py
```

> 📖 **Learn more:** See the [complete guide to creating agents](https://github.com/vm0-ai/vm0-cookbooks/blob/main/docs/vm0-guide.md) for advanced features like custom skills, secrets, and more.

## CLI reference

### Authentication

```bash
vm0 auth login               # Login to VM0
vm0 auth logout              # Logout
vm0 auth status              # Check auth status
```

### Agent management

```bash
vm0 compose <config.yaml>    # Create/update agent compose from config
```

### Running agents

```bash
# Basic run
vm0 run <agent-name> --artifact-name <name> "<prompt>"

# With variables
vm0 run my-agent --artifact-name workspace \
  --vars KEY=value \
  "Do something"

# Resume from checkpoint (full state snapshot)
vm0 run resume <checkpoint-id> "<prompt>"

# Continue from session (latest artifact version)
vm0 run continue <session-id> "<prompt>"
```

### Artifact management

Artifacts are workspaces where agents read/write files.

```bash
mkdir my-workspace && cd my-workspace
vm0 artifact init            # Initialize artifact
vm0 artifact push            # Upload to cloud
vm0 artifact pull            # Download from cloud
vm0 artifact pull <version>  # Pull specific version
```

### Volume management

Volumes are persistent data stores (datasets, configs, dependencies).

```bash
mkdir my-data && cd my-data
vm0 volume init              # Initialize volume
vm0 volume push              # Upload to cloud
vm0 volume pull              # Download from cloud
vm0 volume pull <version>    # Pull specific version
```

## Agent configuration

Create a `vm0.yaml` file to define your agent:

```yaml
version: "1.0"

agents:
  my-agent:
    description: "Agent description"
    provider: claude-code
    image: vm0-claude-code-dev
    working_dir: /home/user/workspace
    volumes:
      - my-volume:/home/user/data

volumes:
  my-volume:
    name: my-data
    version: latest
```

## Key concepts

### Agents

Your AI worker with persistent configuration and memory. Define its capabilities in `vm0.yaml` and give instructions in `CLAUDE.md`. It remembers everything from previous runs. Each agent runs in an isolated sandbox and can specialize in tasks like coding, research, or data processing.

### Images

Pre-configured runtime environments containing the OS, tools, and agent CLI (Claude Code, Codex, etc.). Like Docker images but for AI agents, they're built with E2B templates and ensure consistent execution across runs.

### Artifacts

Your versioned workspace where agents create and modify files. Each change is automatically versioned using SHA-256 content-addressing. Identical content produces the same version (deduplication). Sync bidirectionally between local and cloud, go back to any version, or share with other agents.

### Volumes

Persistent storage for datasets, configs, and dependencies that don't change often. Mounted into agent sandboxes at specific paths, volumes support version pinning for reproducibility. Control exactly which version each agent uses. Great for sharing data across multiple agents.

### Checkpoints

Complete snapshots capturing the full state: artifact files, conversation history, agent memory, and volume versions. Resume from any checkpoint to restore the exact execution state. Useful for debugging, trying different approaches, or recovering from errors.

### Sessions

Lightweight continuations where the agent remembers the conversation but uses your latest artifact version. Perfect for iterative workflows: edit code locally, run session, and the agent continues with your changes. Faster than checkpoints when you just need the agent to see your updates.

## What you can build

| Use case | Description | Example |
|----------|-------------|---------|
| **Coding agents** | Execute code, use terminal, access the web - securely isolated | [GitHub agent](https://github.com/vm0-ai/vm0-cookbooks/tree/main/109-github-agent) |
| **Research agents** | Gather, analyze, and iterate in persistent workspaces | [Competitor research](https://github.com/vm0-ai/vm0-cookbooks/tree/main/108-competitor-research) |
| **Data agents** | Process datasets, train models, generate reports with full state | [HuggingFace trainer](https://github.com/vm0-ai/vm0-cookbooks/tree/main/105-hf-trainer) |
| **Content agents** | Create, refine, and version content across multiple runs | [Content farm](https://github.com/vm0-ai/vm0-cookbooks/tree/main/104-content-farm), [TikTok influencer](https://github.com/vm0-ai/vm0-cookbooks/tree/main/106-tiktok-influencer) |
| **Writing agents** | Generate and refine written content with context | [Writing agent](https://github.com/vm0-ai/vm0-cookbooks/tree/main/102-writing-agent) |

> 📚 **More examples:** Check out [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks) for complete, ready-to-run agent examples.

## Resources

- [Contributing guide](./CONTRIBUTING.md) - Development setup
- [Website](https://www.vm0.ai) - Learn our official website
- [Discord](https://discord.gg/WMpAmHFfp6) - Join our community
- [Email](mailto:ethan@vm0.ai) - Email us for questions and support

## License

See [LICENSE](./LICENSE) for details.
