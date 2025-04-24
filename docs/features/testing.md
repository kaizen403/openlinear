# Testing Guide

Overview of the testing strategy and patterns used in OpenLinear.

## Test Stack

| Tool | Purpose |
|------|---------|
| Vitest | Test runner and assertion library |
| Supertest | HTTP endpoint testing |
| Prisma | Test database setup/teardown |

## Test Structure

Tests live alongside the code they test:

```
apps/api/src/__tests__/
├── auth.test.ts          Authentication endpoints
├── auth-migration.test.ts Auth migration logic
├── tasks.test.ts         Task CRUD endpoints
├── projects.test.ts      Project endpoints
├── teams.test.ts         Team endpoints
├── repos.test.ts         Repository endpoints
├── health.test.ts        Health check endpoint
└── privacy-contract.test.ts Payload sanitization
```

## Running Tests

```bash
# All tests
pnpm test

# API tests only
pnpm --filter @openlinear/api test

# Watch mode
pnpm --filter @openlinear/api test -- --watch

# Single file
pnpm --filter @openlinear/api test -- auth.test.ts

# With coverage
pnpm --filter @openlinear/api test -- --coverage
```

## Test Patterns

### API Route Tests

Each route file has a corresponding test file that tests all endpoints using Supertest:

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app';

describe('GET /api/tasks', () => {
  it('returns tasks list', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .expect(200);

    expect(res.body).toBeInstanceOf(Array);
  });
});
```

### Authentication in Tests

Tests that require authentication create a test user and obtain a JWT:

```typescript
const token = await getTestToken(); // Helper that registers + logs in

await request(app)
  .post('/api/tasks')
  .set('Authorization', `Bearer ${token}`)
  .send({ title: 'Test task' })
  .expect(201);
```

### Database Setup

Tests use Vitest setup files (`vitest.setup.ts`) to configure the test database:

- Fresh database state before each test suite
- Transaction rollback after each test (where applicable)
- Seeded test data for common fixtures

## Configuration

Test configuration in `apps/api/vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
  },
});
```

## What to Test

### Must test:
- All API endpoint happy paths
- Authentication and authorization checks
- Input validation (missing fields, invalid types)
- Error responses (404, 400, 401, 403, 500)

### Should test:
- Edge cases (empty strings, very long inputs)
- Concurrent operations
- Pagination behavior

### Don't test:
- Prisma ORM internals
- Third-party library behavior
- UI component rendering (separate concern)
