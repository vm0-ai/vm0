# VM0 Schedule Demo
Output schedule.gif

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

Type "# 1. Initialize schedule"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 schedule init"
Sleep 1s
Enter
Sleep 2s

# Accept all interactive prompts with defaults
Enter
Sleep 1500ms
Enter
Sleep 1500ms
Enter
Sleep 1500ms
Enter
Sleep 1500ms
Enter
Sleep 2s

Enter
Type "# 2. View generated schedule.yaml"
Sleep 1s
Enter
Sleep 300ms
Type "cat schedule.yaml"
Sleep 1s
Enter
Sleep 3s

Enter
Type "# 3. Deploy the schedule"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 schedule deploy"
Sleep 1s
Enter
Sleep 4s

Enter
Type "# 4. List all schedules"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 schedule list"
Sleep 1s
Enter
Sleep 3s

Enter
Type "# 5. Check schedule status"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 schedule status"
Sleep 1s
Enter
Sleep 4s
