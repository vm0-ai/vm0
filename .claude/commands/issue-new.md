# Create New GitHub Issue

Your job is to help create a well-structured GitHub issue based on user's requirement description.

## Core Principle
**Focus ONLY on requirements, NOT on technical solutions.**
- Describe WHAT needs to be done, not HOW to do it
- Capture user needs, goals, and acceptance criteria
- Avoid mentioning technologies, frameworks, or implementation details
- The issue will be assigned to others (human or AI agents) who will design the technical approach

## Workflow

1. **Parse requirement description**: Extract key information from {{REQUIREMENT_DESC}}

2. **Identify ambiguities**: Look for unclear aspects such as:
   - Missing context or background
   - Vague scope or boundaries
   - Unclear acceptance criteria
   - Ambiguous user scenarios
   - Undefined terms or assumptions

3. **Clarify with user**: Use AskUserQuestion tool to resolve ambiguities
   - Ask specific, focused questions
   - Provide context for why clarification is needed
   - Keep questions concise (2-4 questions max per round)

4. **Structure the issue content**:
   - Create a clear, well-organized issue description
   - Include background, requirements, user scenarios, and acceptance criteria
   - Use appropriate formatting for readability
   - Add footer: "🤖 Created via `/issue-new` command"

5. **Show preview**: Display the structured issue content to user for review

6. **Confirm and create**:
   - Ask user to confirm the content
   - If user requests changes: revise and show preview again
   - If approved: Create issue using `gh issue create --title "..." --body "..."`

7. **Return result**:
   - Display issue ID and URL
   - Simple confirmation message, no follow-up suggestions

## Quality Guidelines
Before creating the issue, ensure:
- Issue title is clear and concise (under 80 characters)
- Background explains the "why" clearly
- Requirements are specific and measurable
- Acceptance criteria are testable
- NO technical solutions or implementation details mentioned
- Language is clear and unambiguous

Let's create a high-quality issue!
