<h2 align="center">
  <a href="https://vm0.ai"><img src="https://github.com/vm0-ai/vm0/blob/main/turbo/apps/web/public/assets/Logo_VM0_combo_black_bg.svg" alt="VM0 Logo" width="500"></a>
  <br>
  <br>
  Skill workflows, while you sleep
  <br>
  <br>
  <p>
    <a href="https://deepwiki.com/vm0-ai/vm0"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki" /></a>
    <img src="https://img.shields.io/npm/types/@vm0/cli" alt="NPM Type Definitions" />
    <img src="https://img.shields.io/npm/v/@vm0/cli" alt="NPM Version" />
    <img src="https://img.shields.io/bundlejs/size/@vm0/cli" alt="Bundle Size" />
    <a href="https://github.com/vm0-ai/vm0/actions/workflows/turbo.yml?query=event%3Apush+branch%3Amain"><img src="https://github.com/vm0-ai/vm0/actions/workflows/turbo.yml/badge.svg?event=push"
    alt="CI" /></a>
  </p>
</h2>

[Documentation](https://docs.vm0.ai) / [Website](https://www.vm0.ai) / [Join Waitlist](https://www.vm0.ai/sign-up) / [Discord](https://discord.gg/WMpAmHFfp6)

`VM0` runs natural language-described workflows automatically on schedule in remote sandbox environments (E2B containers or Firecracker microVMs with KVM isolation).

⭐ Star us on GitHub, it motivates us a lot! ⭐

---

## 🔥 What you GET

- **Cloud sandbox**, run Claude Code or Codex agents in isolated containers
- **60+ skills**, GitHub, Slack, Notion, Firecrawl, and [more](https://github.com/vm0-ai/vm0-skills)
- **Persistence**, continue chat, resume, fork, and version your workflow sessions
- **Observability**, logs, metrics, and network visibility for every run

**Supported**: Claude Code, Codex · **Coming soon**: Gemini CLI, DeepAgent CLI, OpenCode

## 🚀 [Quick Start](https://docs.vm0.ai/docs/quick-start)

From zero to workflow agent in 5 minutes

```bash
npm install -g @vm0/cli
vm0 auth login
mkdir my-agent && cd my-agent

vm0 init
cat AGENTS.md # check the workflow which your agent will run
vm0 cook "let's start working"
```

<img src="https://raw.githubusercontent.com/vm0-ai/vm0-cookbooks/main/tapes/welcome/welcome.gif" alt="VM0 CLI Quickstart Demo" width="500">

## 📚 Architecture

<p align="center">
  <a href="./docs/architecture.md">
    <img src="./docs/arch.svg" alt="VM0 Architecture Diagram" width="800">
  </a>
</p>

- **[Architecture Documentation](./docs/architecture.md)** - Comprehensive technical reference covering sandbox technologies (E2B, Firecracker), infrastructure components and network architecture

For user-facing guides and tutorials, visit [docs.vm0.ai](https://docs.vm0.ai).

## 🤝 Contribute

<p><a href="https://github.com/vm0-ai/vm0/blob/main/CONTRIBUTING.md">
  <img src="https://contrib.rocks/image?repo=vm0-ai/vm0" />
</a></p>

![Alt](https://repobeats.axiom.co/api/embed/ef46db5e11f5146fcc8af07077a79d789efdfbe5.svg "Repobeats analytics image")

## 📃 License

See [LICENSE](./LICENSE) for details.
