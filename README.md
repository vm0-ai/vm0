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
  <strong>Build agents and automate workflows with natural language</strong>
</p>

<p align="center">
  <a href="https://www.vm0.ai">Website</a> •
  <a href="https://www.vm0.ai/sign-up">Join Waitlist</a> •
  <a href="https://discord.gg/WMpAmHFfp6">Discord</a> •
  <a href="mailto:ethan@vm0.ai">Contact</a>
</p>

---

## What is VM0?

VM0 helps you build agents and automated workflows using natural language.

It also provides a full agent runtime with:
- Secure cloud sandbox: isolated execution environments for running agents safely
- Versioned storage: track, reproduce, and roll back agent state and artifacts
- Persistent execution: resume, fork, and iterate on agent runs with full history
- Complete observability: logs, metrics, and network visibility for every run

You can build and extend agents using:
- Natural language workflows: define agent behavior in plain text, without complex graphs or pipelines
- Pluggable skills: add capabilities through reusable [agent skills](https://github.com/vm0-ai/vm0-skills)
  
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

> For full documentation, visit [docs.vm0.ai](https://docs.vm0.ai/docs).

## Resources

- [vm0-cookbooks](https://github.com/vm0-ai/vm0-cookbooks) - Ready-to-run examples
- [vm0-skills](https://github.com/vm0-ai/vm0-skills) - Agent skills library
- [Contributing guide](./CONTRIBUTING.md) - Development setup
- [Website](https://www.vm0.ai) - Official website
- [Discord](https://discord.gg/WMpAmHFfp6) - Join our community
- [Email](mailto:ethan@vm0.ai) - Questions and support

## License

See [LICENSE](./LICENSE) for details.
