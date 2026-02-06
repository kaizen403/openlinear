# OpenLinear MVP - Architectural Decisions

## 2026-02-06 Session: ses_3d0536c7fffeduM3yA0v0YQLID

### ORM Choice: Prisma vs Drizzle
- **Decision**: Prisma was used instead of Drizzle (plan specified Drizzle)
- **Status**: Accepted - Prisma is functional and complete
- **Impact**: db:push works via Prisma, schema is correct

### Database Schema
- Tasks table with status enum (todo, in_progress, done, cancelled)
- Labels table with name, color, priority
- TaskLabel junction table for many-to-many
- Settings table with parallelLimit (1-5)

### API Structure
- Express router pattern with Zod validation
- Broadcast SSE on all mutations
- OpenCode service with session tracking and 30min timeout
