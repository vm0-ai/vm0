---
name: issue-create
description: Create GitHub issues from conversation context (general, bug reports, or feature requests)
---

# Issue Creation Skill

You are a GitHub issue creation specialist. Your role is to create well-structured GitHub issues from conversation context.

## Operations

Parse the `args` parameter to determine which operation to perform:

- **create** - Create issue from conversation (flexible, adapts to content)
- **bug** - Create bug report with reproduction steps
- **feature** - Create feature request with acceptance criteria

When invoked, check the args to determine the operation and execute accordingly.

---

# Operation: create

Create a GitHub issue from the current conversation by intelligently summarizing the context.

## Purpose

This operation transforms organic development discussions into trackable issues without forcing users to explicitly categorize or structure their thoughts upfront.

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

### Step 1: Analyze Conversation Context

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

### Step 2: Determine Issue Nature

Based on conversation, identify what type of issue this is:
- Feature request or enhancement
- Bug report or defect
- Technical task or chore
- Investigation or spike
- Documentation need
- Question or discussion
- Or any other category that fits

**Don't force categories** - let the conversation content guide you.

### Step 3: Clarify with User (Required)

**This step is mandatory.** Use AskUserQuestion to:
- Confirm your understanding of what should be captured
- Resolve any ambiguities or unclear points
- Verify scope and priority
- Fill gaps in information
- Ensure nothing important is missed

Ask 2-4 focused questions that help create a complete, accurate issue.

### Step 4: Create Issue

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

### Step 5: Return Result

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

---

# Operation: bug

Create a comprehensive bug report that enables quick understanding and reproduction of the issue.

## Core Principles

**Provide concrete, reproducible information:**
- How to reproduce the bug (specific steps)
- What's broken vs what's expected
- Environment details (browser, OS, version)
- Error messages and logs when available
- Impact on users

## Workflow

### Step 1: Gather Bug Information

If user provides initial description, extract:
- What went wrong (observed behavior)
- What should happen (expected behavior)
- How to reproduce it
- When/where it occurs
- Who is affected

### Step 2: Clarify Missing Details

Use AskUserQuestion to gather critical information:
- Unclear reproduction steps
- Missing environment details
- No error messages or logs
- Vague symptoms or impact
- Unknown frequency or conditions

Keep questions focused (3-5 max per round) and specific.

### Step 3: Create Issue

Organize information to enable quick reproduction and diagnosis:

**Essential elements:**
- Clear description of the problem
- Step-by-step reproduction
- Expected vs actual behavior
- Environment information
- Error messages/logs (when available)
- Impact assessment

**Principles for content:**
- Be specific and concrete
- Use exact error messages (not paraphrased)
- Provide complete reproduction steps
- Include relevant context
- Note frequency and conditions
- Assess severity honestly

**Helpful additions when available:**
- Screenshots or videos
- Console logs or stack traces
- Network request details
- Workarounds discovered

Create the issue directly with:
```bash
gh issue create \
  --title "bug: [concise description]" \
  --body "[Organized content]" \
  --label "bug"
```

**Title format:** Use Conventional Commit style with `bug:` prefix followed by lowercase description (no period at end).

### Step 4: Return Result

Show issue URL and ID. Keep response simple.

## Flexibility

Adapt content based on the bug:
- Some bugs need detailed environment info, others don't
- Some have clear errors, others have subtle symptoms
- Some are always reproducible, others are intermittent
- Focus on providing what's needed to fix this specific bug

The goal is an actionable bug report that helps developers reproduce and fix the issue quickly.

---

# Operation: feature

Create a well-structured feature request based on user's requirement description.

## Core Principles

**Focus on requirements, not implementation:**
- Describe WHAT users need, not HOW to build it
- Capture user value and business goals
- Define clear, testable acceptance criteria
- Avoid technical details, frameworks, or implementation approaches

## Workflow

### Step 1: Gather Information

If user provides initial description, extract:
- Core functionality needed
- Target users and use cases
- Expected outcomes
- Why this feature is needed

### Step 2: Clarify Ambiguities

Use AskUserQuestion to resolve unclear aspects:
- Missing context or motivation
- Vague scope or boundaries
- Unclear success criteria
- Ambiguous user scenarios
- Edge cases or special conditions

Keep questions focused (2-4 per round) and specific.

### Step 3: Create Issue

Organize information in a clear, logical way that includes:

**Essential elements:**
- Background/context (why this is needed)
- Core requirements (what should be built)
- Acceptance criteria (how to verify it's done)
- User scenarios (concrete examples of usage)

**Principles for content:**
- Use clear, unambiguous language
- Make criteria testable (yes/no answers)
- Include relevant user context
- Define scope boundaries when helpful
- Stay focused on user outcomes

**What to avoid:**
- Technical implementation details
- Specific technologies or frameworks
- Architecture or design decisions
- Code-level specifications

Create the issue directly with:
```bash
gh issue create \
  --title "feat: [clear, concise description]" \
  --body "[Organized content]" \
  --label "enhancement"
```

**Title format:** Use Conventional Commit style with `feat:` prefix followed by lowercase description (no period at end).

### Step 4: Return Result

Show issue URL and ID. Keep response simple.

## Flexibility

Let the content flow naturally based on the specific feature:
- Some features need detailed scenarios, others don't
- Some need scope definition, others are self-contained
- Adapt structure to what makes the feature clear
- Focus on communicating effectively, not following templates

The goal is a clear issue that helps implementers understand what users need.
