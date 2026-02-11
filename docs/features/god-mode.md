# God Mode

A floating quick-access overlay for triggering Brainstorm from anywhere in the app.

## Activation

| Platform | Shortcut |
|----------|----------|
| macOS | Option + Space |
| Windows / Linux | Ctrl + K |

Alternatively, click the floating brain icon button in the bottom-right corner of the screen.

## Behavior

1. A pill-shaped input bar slides up from the bottom of the screen
2. Type a query (e.g. "refactor the auth middleware")
3. Press Enter to submit
4. The overlay dismisses and dispatches a `brainstorm-query` custom event
5. The Brainstorm panel picks up the event and generates tasks

Press Escape to dismiss without submitting.

## UI Elements

The pill bar includes:
- A text input with "Ask anything..." placeholder
- "Brainstorm" label
- Globe button (web search toggle)
- Microphone button
- Submit button (arrow icon)

The floating trigger button pulses gently to indicate availability.
