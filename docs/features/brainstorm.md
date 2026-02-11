# Brainstorm

AI-powered task generation. Describe a goal in natural language and get structured, prioritized tasks you can insert directly into your board.

## How It Works

1. Open the Brainstorm panel from the sidebar or via God Mode
2. Type a goal (e.g. "Add pagination to the users API and write tests")
3. Press Enter to generate
4. AI returns a list of tasks, each with:
   - **Title** -- actionable task name
   - **Reasoning** -- why this task matters
   - **Priority** -- high, medium, or low
5. Review the generated tasks and click "Insert" on the ones you want to add to your board

## Interface

The Brainstorm panel has two phases:

**Input phase:** Shows the input field, a brief description of the feature, and a "Press Enter to generate" hint. Three toggle options are available:
- Web search
- Research mode
- Writing mode

**Stream phase:** Shows generated task cards with:
- Priority indicator (color-coded: red for high, yellow for medium, green for low)
- Title and reasoning
- Insert button per task
- Counter showing inserted/total

A skeleton loading animation plays while tasks are generating.

## Inserting Tasks

Clicking "Insert" on a generated task creates it as a real task on the board with status `todo`. The card updates to show it has been inserted.

## Starting Over

Click "Start over" to clear all generated tasks, reset the input, and return to the input phase.

## Trigger Methods

- Click "Brainstorm" in the sidebar
- Use the God Mode overlay (Option+Space on Mac, Ctrl+K on Windows/Linux)
- The God Mode dispatches a `brainstorm-query` custom event that the Brainstorm panel listens for
