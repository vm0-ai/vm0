#!/usr/bin/env bash

set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_SKILLS_DIR="$WORKSPACE_DIR/.claude/skills"
AGENTS_DIR="$WORKSPACE_DIR/.agents"
AGENT_SKILLS_LINK="$AGENTS_DIR/skills"
LINK_TARGET="../.claude/skills"

if [ ! -d "$CLAUDE_SKILLS_DIR" ]; then
  exit 0
fi

mkdir -p "$AGENTS_DIR"

if [ -L "$AGENT_SKILLS_LINK" ]; then
  ln -sfn "$LINK_TARGET" "$AGENT_SKILLS_LINK"
elif [ -e "$AGENT_SKILLS_LINK" ]; then
  if [ ! -d "$AGENT_SKILLS_LINK" ]; then
    echo "Skipping .agents/skills link because a non-directory entry already exists"
    exit 0
  fi

  if find "$AGENT_SKILLS_LINK" -mindepth 1 -maxdepth 1 ! -type l -print -quit | grep -q .; then
    echo "Skipping .agents/skills link because it contains non-symlink entries"
    exit 0
  fi

  find "$AGENT_SKILLS_LINK" -mindepth 1 -maxdepth 1 -type l -exec rm {} +
  rmdir "$AGENT_SKILLS_LINK"
  ln -s "$LINK_TARGET" "$AGENT_SKILLS_LINK"
else
  ln -s "$LINK_TARGET" "$AGENT_SKILLS_LINK"
fi

echo "Linked .agents/skills to .claude/skills"
