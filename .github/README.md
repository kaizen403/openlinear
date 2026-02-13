<div align="center">

# KazCode

**Turn your kanban board into a code-shipping machine.**

KazCode is an open-source desktop app that connects a Linear-style task board to AI coding agents. Create a task, describe what you want, hit execute — and get a pull request with working code.

[![GitHub](https://img.shields.io/github/stars/kaizen403/openlinear?style=social)](https://github.com/kaizen403/openlinear)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/kaizen403/openlinear/blob/main/LICENSE)
[![Live](https://img.shields.io/badge/try%20it-rixie.in-purple)](https://rixie.in)

</div>

---

### Why KazCode?

Most AI coding tools are chat-first. KazCode is **task-first**. You plan your work on a kanban board, then let AI agents execute tasks in isolated environments — each user gets their own Docker container, their own credentials, their own branches.

### Key Capabilities

- **One-click task execution** — describe the task, click execute, receive a pull request
- **Batch execution** — run multiple tasks in parallel or queue mode, merged into a single PR
- **Per-user isolation** — every user gets a dedicated Docker container with sandboxed credentials
- **Real-time visibility** — watch the AI agent's tool calls, file edits, and decisions as they happen
- **GitHub-native** — OAuth login, automatic repo cloning, branch management, and PR creation

### Built With

Next.js, Tauri, Express.js, PostgreSQL, Prisma, Docker, OpenCode SDK

### Get Started

```bash
git clone https://github.com/kaizen403/openlinear.git
cd openlinear && pnpm install
docker compose up -d
pnpm db:push && pnpm dev
```

Full setup guide and architecture docs in the [repository](https://github.com/kaizen403/openlinear).

### Links

- [Repository](https://github.com/kaizen403/openlinear)
- [Documentation](https://github.com/kaizen403/openlinear/tree/main/docs/features)
- [Architecture](https://github.com/kaizen403/openlinear/blob/main/docs/ARCHITECTURE.md)
- [Releases](https://github.com/kaizen403/openlinear/releases)
- [Live Instance](https://rixie.in)

### License

[MIT](https://github.com/kaizen403/openlinear/blob/main/LICENSE)
