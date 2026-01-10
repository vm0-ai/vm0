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
  <strong>Skill workflows, while you sleep</strong>
</p>

<p align="center">
  <a href="https://www.vm0.ai">Website</a> •
  <a href="https://www.vm0.ai/sign-up">Join Waitlist</a> •
  <a href="https://discord.gg/WMpAmHFfp6">Discord</a> •
  <a href="mailto:ethan@vm0.ai">Contact</a>
</p>

---

## What You Get

- **Cloud sandbox** — Run Claude Code or Codex agents in isolated containers
- **60+ skills** — GitHub, Slack, Notion, Firecrawl, and [more](https://github.com/vm0-ai/vm0-skills)
- **Persistence** — Continue chat, resume, fork, and version your workflow sessions
- **Observability** — Logs, metrics, and network visibility for every run

**Supported**: Claude Code, Codex (beta) · **Coming soon**: Gemini CLI, self-hosted runner

## Quick Start

```bash
npm install -g @vm0/cli
vm0 auth login
```

```bash
mkdir my-agent && cd my-agent
vm0 init
cat > AGENTS.md << 'EOF'
# Workflow
1. Go to HackerNews and read the top 10 articles
2. Find and extract AI-related content from these articles
3. Summarize the findings into a X (Twitter) post format
4. Write the summary to content.md
EOF

vm0 cook "follow your workflow"
```

## Resources

[Documentation](https://docs.vm0.ai) · [Skills](https://github.com/vm0-ai/vm0-skills) · [Discord](https://discord.gg/WMpAmHFfp6)

## License

See [LICENSE](./LICENSE) for details.
