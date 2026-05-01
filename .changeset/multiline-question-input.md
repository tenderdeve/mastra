---
'mastracode': minor
---

Added opt-in multiline support to free-text question prompts. The `ask_user` tool now uses a multiline editor — Shift+Enter (or \\+Enter) inserts a new line, Enter submits, text wraps within the input area instead of overflowing horizontally. Slash-command prompts that ask for short answers (paths, names, yes/no) keep the single-line input. Set `multiline: true` on `AskQuestionInlineComponent` / `AskQuestionDialogComponent` options to opt in.
