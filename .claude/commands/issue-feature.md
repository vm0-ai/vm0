---
description: Create a feature request issue focused on user requirements and acceptance criteria
---

# Create Feature Request Issue

Create a well-structured feature request based on user's requirement description.

## Core Principles

**Focus on requirements, not implementation:**
- Describe WHAT users need, not HOW to build it
- Capture user value and business goals
- Define clear, testable acceptance criteria
- Avoid technical details, frameworks, or implementation approaches

## Workflow

### 1. Gather Information

If user provides initial description, extract:
- Core functionality needed
- Target users and use cases
- Expected outcomes
- Why this feature is needed

### 2. Clarify Ambiguities

Use AskUserQuestion to resolve unclear aspects:
- Missing context or motivation
- Vague scope or boundaries
- Unclear success criteria
- Ambiguous user scenarios
- Edge cases or special conditions

Keep questions focused (2-4 per round) and specific.

### 3. Create Issue

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

### 4. Return Result

Show issue URL and ID. Keep response simple.

## Flexibility

Let the content flow naturally based on the specific feature:
- Some features need detailed scenarios, others don't
- Some need scope definition, others are self-contained
- Adapt structure to what makes the feature clear
- Focus on communicating effectively, not following templates

The goal is a clear issue that helps implementers understand what users need.
