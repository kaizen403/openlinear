# OpenLinear Database Setup

## Neon Project

- **Project ID:** `<your-neon-project-id>`
- **Project Name:** `<your-neon-project-name>`
- **Region:** `aws-ap-southeast-1`
- **Organization:** `<your-neon-org-id>`

## Branches

| Branch | Type | Purpose |
|---|---|---|
| **production** | Primary/Default | Production data |
| **development** | Child of production | Development/Local testing |

## Environment Files

### Development (`.env`)
- **Branch:** `development`
- **Connection String:** Uses the dev branch pooled endpoint
- **Pooled:** Yes (recommended for Prisma/connection pooling)

### Production (`.env.production`)
- **Branch:** `production`
- **Connection String:** Uses the prod branch pooled endpoint
- **Pooled:** Yes (recommended for Prisma/connection pooling)

## Management Commands

### List branches
```bash
neonctl branches list --project-id <your-neon-project-id>
```

### Get connection strings
```bash
# Development (pooled)
neonctl connection-string <dev-branch-name> --project-id <your-neon-project-id> --pooled

# Production (pooled)
neonctl connection-string <prod-branch-name> --project-id <your-neon-project-id> --pooled
```

### Reset development branch from production
```bash
neonctl branches reset <dev-branch-name> --project-id <your-neon-project-id> --parent
```

### Create a new branch from production
```bash
neonctl branches create --project-id <your-neon-project-id> --parent <prod-branch-name> --name feature-branch
```

## Important Notes

1. **Development branch** is a copy of production
2. **Reset development** to sync with latest production data using `neonctl branches reset`
3. **Both branches** have separate read-write compute endpoints (auto-scaling 0.25-2 CU)
4. **Pooled connections** are used for Prisma compatibility
5. **SSL is required** for all connections (Neon enforces this)

## Migration Workflow

1. Run migrations locally against dev branch:
   ```bash
   pnpm --filter @openlinear/db db:migrate:deploy
   ```

2. Test thoroughly with dev data

3. Deploy to production:
   ```bash
   # Set production env
   cp .env.production .env
   
   # Deploy migrations
   pnpm --filter @openlinear/db db:migrate:deploy
   ```
