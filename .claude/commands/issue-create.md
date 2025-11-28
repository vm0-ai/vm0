---
description: Create a GitHub issue by intelligently summarizing the current conversation context
---

# Create Issue from Conversation

Analyze the current conversation and create a well-structured GitHub issue that captures the key points, decisions, and context.

## Purpose

This command transforms organic development discussions into trackable issues without forcing users to explicitly categorize or structure their thoughts upfront.

## Core Principles

**Intelligent context extraction:**
- Understand what the user wants from conversation flow
- Identify the type of issue organically (feature, bug, task, question, etc.)
- Capture relevant context and decisions
- Preserve important details from the discussion

**Flexible and adaptive:**
- No rigid templates or categories
- Adapt to the conversation's natural structure
- Let content determine organization
- Focus on clarity and usefulness

## Workflow

### 1. Analyze Conversation Context

Review the current conversation to identify:
- What is the user trying to accomplish or solve?
- What problem or need has been discussed?
- What decisions or insights have emerged?
- What relevant code, files, or technical context exists?
- What questions or uncertainties remain?

**Scope of analysis:**
Use your judgment to determine relevant context:
- For focused discussions: recent messages that directly relate to the topic
- For exploratory conversations: broader context that provides background
- Prioritize actionable information over general discussion

### 2. Determine Issue Nature

Based on conversation, identify what type of issue this is:
- Feature request or enhancement
- Bug report or defect
- Technical task or chore
- Investigation or spike
- Documentation need
- Question or discussion
- Or any other category that fits

**Don't force categories** - let the conversation content guide you.

### 3. Clarify with User (Required)

**This step is mandatory.** Use AskUserQuestion to:
- Confirm your understanding of what should be captured
- Resolve any ambiguities or unclear points
- Verify scope and priority
- Fill gaps in information
- Ensure nothing important is missed

Ask 2-4 focused questions that help create a complete, accurate issue.

### 4. Create Issue

Synthesize the conversation into a clear issue:

**Structure naturally based on content:**
- Start with clear context and background
- Explain what needs to happen or what's wrong
- Include relevant details from the conversation
- Reference code, files, or technical specifics when relevant
- Note decisions, constraints, or requirements
- Capture any open questions or next steps

**Guidelines:**
- Write clearly and concisely
- Include enough context for someone new to understand
- Link to relevant conversations, PRs, or issues
- Use appropriate formatting (code blocks, lists, etc.)
- Add a footer noting it was created from conversation

**Title format:**
Use Conventional Commit style prefix based on issue type:
- `feat:` for new features or enhancements
- `bug:` for defects or broken functionality
- `docs:` for documentation work
- `refactor:` for code improvements or tech debt
- `test:` for testing-related tasks
- `chore:` for maintenance or build tasks
- `perf:` for performance improvements
- Or other appropriate prefixes

Always use lowercase after the prefix, no period at end.

**Labeling:**
Choose labels based on issue nature:
- `enhancement` for new features
- `bug` for defects
- `documentation` for docs work
- `question` for discussions
- `tech-debt` for refactoring/improvements
- Or any combination that fits

Create the issue:
```bash
gh issue create \
  --title "[type]: [clear, descriptive description]" \
  --body "[Synthesized content]" \
  --label "[appropriate-labels]"
```

### 5. Return Result

Show issue URL and ID. Keep response simple.

## Flexibility

**Embrace conversation diversity:**
- Technical deep-dives → capture technical context
- User problem discussions → focus on requirements
- Bug investigations → include reproduction details
- Design explorations → preserve options and trade-offs
- Mixed conversations → organize logically

**Adapt to conversation style:**
- Structured discussions may yield structured issues
- Exploratory chats may need more synthesis
- Quick exchanges may produce concise issues
- Complex threads may need thorough documentation

## Examples of Issue Types

**From a feature discussion:**
> Conversation about users needing CSV export
→ Creates enhancement issue with user requirements

**From debugging session:**
> Conversation investigating why authentication fails
→ Creates bug issue with reproduction steps and findings

**From code review discussion:**
> Conversation about refactoring the database layer
→ Creates tech-debt issue with rationale and approach

**From open-ended exploration:**
> Conversation about improving performance
→ Creates investigation issue with questions and context

The goal is to make issue creation natural and friction-free while maintaining quality and clarity.
