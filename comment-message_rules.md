# Commit Message Rules

- lowercase past tense
- no capital letters
- no hashtags
- no issue numbers
- no long hyphens
- just normal commands in portions

## Examples

- added codebase context service for keyword extraction and file ranking
- refactored brainstorm service with basic and pro modes
- unified design tokens and set boxy radius across the ui
- removed broken font references and fixed font classes
- replaced off-system zinc and white opacity colors with design tokens
- move cors middleware before rate limiters to fix blocked responses

## Workflow

1. create github issue
2. fix locally
3. commit with plain lowercase past tense message
4. close issue via `gh issue close`
5. don't push until done for the day
