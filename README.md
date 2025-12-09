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

- 🧱 **Container runners** — traditional tech stack
- 🔗 **Workflow builders** — rigid, brittle, not agent-native

Agents require a fundamentally different environment.

**VM0 is the runtime purpose-built for agents.**  
No workflows. No black-box containers. Just a clean, persistent, observable place for agents to live, think, and evolve.

---

## Build agents the modern way

### Natural-language powered

Write a prompt or a simple config file — your agent is ready.  
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

### Fastest way

```bash
vm0 auth login
vm0 build vm0.yaml
mkdir workspace && cd workspace
vm0 artifact init
vm0 run my-agent --artifact-name workspace "Create a Python hello world script"
vm0 artifact pull
```

> **💡 Tip:** Check out [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks) for ready-to-use examples with `vm0 cook` command that auto-handles setup.

### Manual setup (step by step)

For full control over volumes and artifacts:

**1. Login**
```bash
vm0 auth login
```

**2. Create agent config**
```bash
cat > vm0.yaml << 'EOF'
version: "1.0"
agents:
  - name: my-agent
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
```

**3. Build agent**
```bash
vm0 build vm0.yaml
```

**4. Prepare volume (if needed)**
```bash
mkdir claude-files && cd claude-files
vm0 volume init
vm0 volume push
cd ..
```

**5. Prepare artifact workspace**
```bash
mkdir workspace && cd workspace
vm0 artifact init
vm0 artifact push  # Optional: upload existing files
```

**6. Run agent**
```bash
vm0 run my-agent --artifact-name workspace "Create a Python hello world script"
```

**7. Get results**
```bash
vm0 artifact pull
cat hello.py
```

## CLI reference

### Authentication

```bash
vm0 auth login               # Login to VM0
vm0 auth logout              # Logout
vm0 auth status              # Check auth status
```

### Agent management

```bash
vm0 build <config.yaml>      # Create/update agent from config
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
  - name: my-agent
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

### Environment variables

Use environment variables in configs:

```yaml
volumes:
  api-keys:
    name: "${ENV}-keys"
    version: "${VERSION}"
```

```bash
export ENV=production
export VERSION=v1.0.0
vm0 build vm0.yaml
```

> 📖 **Learn more:** See the [complete guide to creating your own agents](https://github.com/vm0-ai/vm0-cookbooks/blob/main/docs/vm0-guide.md) for step-by-step instructions, best practices, and advanced features like skills and secrets.

## Key concepts

### Agents

Stateful AI entities that execute tasks in isolated sandboxes. Each agent:
- Has a persistent configuration defined in `vm0.yaml`
- Maintains memory and context across runs
- Can access volumes and artifacts
- Supports checkpoint/resume for exact state restoration
- Runs in a secure, isolated environment

### Images

Pre-configured runtime environments for agents. Images:
- Define the base system and installed tools
- Include agent CLI (e.g., Claude Code, Codex)
- Are built with E2B templates or custom Dockerfiles
- Can be versioned and shared across agents
- Provide consistent execution environments

### Artifacts

Versioned workspaces where agents read and write files (code, documents, outputs). Artifacts:
- Are automatically versioned on each `push`
- Use content-addressable storage with SHA-256 hashing
- Support deduplication (identical content = same version)
- Can be shared across multiple agent runs
- Sync bidirectionally between local and cloud

### Volumes

Persistent data stores for datasets, configurations, and dependencies. Volumes:
- Are mounted into agent sandboxes at specified paths
- Support version pinning for reproducibility
- Can be shared across multiple agents
- Remain independent of artifact changes
- Ideal for read-only data or shared resources

### Checkpoints

Point-in-time snapshots of a complete agent run. Each checkpoint includes:
- Full artifact state at that moment
- Complete conversation history
- Agent memory and reasoning context
- Volume versions used in the run
- Can be resumed to continue from exact state

### Sessions

Lightweight continuations of agent runs. Sessions:
- Use the latest artifact version (not snapshot)
- Maintain conversation context and history
- Faster than checkpoint resume
- Ideal for iterative development
- Automatically track conversation flow

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
- [Website](https://www.vm0.ai) - Learn more
- [Discord](https://discord.gg/WMpAmHFfp6) - Community
- [Email](mailto:ethan@vm0.ai) - Support

## License

See [LICENSE](./LICENSE) for details.
