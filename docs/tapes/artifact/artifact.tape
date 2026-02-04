# VM0 Artifact Demo
Output artifact.gif

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

Type "# 1. Create artifact directory"
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
Type "# 4. Run agent with artifact"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 run compose-demo --artifact-name my-artifact 'Write hello world to hello.txt'"
Sleep 1s
Enter
Wait+Screen@120s /Run completed successfully/
Sleep 8s

Enter
Type "# 5. Pull artifact to get result"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 artifact pull"
Sleep 1s
Enter
Sleep 4s

Enter
Type "# 6. View the result"
Sleep 1s
Enter
Sleep 300ms
Type "cat hello.txt"
Sleep 1s
Enter
Sleep 4s
