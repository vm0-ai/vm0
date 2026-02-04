# VM0 Multi-Agents Demo
Output multi-agents.gif

# Terminal settings
Set Shell bash
Set FontSize 22
Set FontFamily "Menlo"
Set Width 1200
Set Height 900
Set Padding 30
Set Theme "Dracula"
Set TypingSpeed 50ms

# Start demo
Sleep 500ms

Type "# 1. Create shared artifact"
Sleep 1s
Enter
Sleep 300ms
Type "mkdir my-artifact && cd my-artifact"
Sleep 1s
Enter
Sleep 2s

Enter
Type "# 2. Initialize artifact"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 artifact init"
Sleep 1s
Enter
Sleep 2s

# Accept default name
Enter
Sleep 3s

Enter
Type "# 3. Push artifact to cloud"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 artifact push"
Sleep 1s
Enter
Sleep 4s

Enter
Type "# 4. Agent-1 writes a question"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 run agent-1 --artifact-name my-artifact 'Write 1+1=? to question.md'"
Sleep 1s
Enter
Wait+Screen@120s /Run completed successfully/
Sleep 8s

# Clear screen so agent-2's Wait+Screen doesn't match agent-1's output
Ctrl+l
Sleep 1s

Type "# 5. Agent-2 reads and answers"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 run agent-2 --artifact-name my-artifact 'Read question.md and answer it in answer.md'"
Sleep 1s
Enter
Wait+Screen@120s /Run completed successfully/
Sleep 8s

Enter
Type "# 6. Pull artifact to get results"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 artifact pull"
Sleep 1s
Enter
Sleep 4s

Enter
Type "# 7. View the question"
Sleep 1s
Enter
Sleep 300ms
Type "cat question.md"
Sleep 1s
Enter
Sleep 5s

Enter
Type "# 8. View the answer"
Sleep 1s
Enter
Sleep 300ms
Type "cat answer.md"
Sleep 1s
Enter
Sleep 5s
