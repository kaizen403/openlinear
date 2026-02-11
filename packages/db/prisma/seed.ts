import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Pre-computed bcrypt hash of "kaz" with 10 salt rounds
// Generated via: bcrypt.hash('kaz', 10)
const KAZ_PASSWORD_HASH =
  "$2a$10$9nD7hcFzJXMrUMChzUMn8uM7vjcJnCCBsGGep8xyhriffyCbO9cnK";

const SEED_TASKS = [
  {
    id: "seed-task-001",
    title: "Fix wrong package name in package.json",
    description:
      'The `name` field in `package.json` is set to `"mcp-ctf"` but the repo is `postgres-mpc-server`. Update it to match the actual project name.',
    priority: "low" as const,
    status: "todo" as const,
  },
  {
    id: "seed-task-002",
    title: "Remove unused @faker-js/faker dependency",
    description:
      "`@faker-js/faker` is listed in `package.json` dependencies but is never imported anywhere in the codebase. The seed file uses hand-rolled helpers instead. Remove it to keep dependencies clean.",
    priority: "low" as const,
    status: "todo" as const,
  },
  {
    id: "seed-task-003",
    title: "Add a .env.example file",
    description:
      "`.env` is gitignored but there's no `.env.example` so new users have to read through the source to figure out which env vars are needed. Add a `.env.example` with `DATABASE_URL` and `GROQ_API_KEY` placeholders.",
    priority: "medium" as const,
    status: "todo" as const,
  },
  {
    id: "seed-task-004",
    title: "Add a GET /health endpoint",
    description:
      'The server only handles `POST /query` — every other request returns a 404. Add a `GET /health` endpoint that returns `{ "status": "ok" }` so monitoring tools and load balancers can check if the server is up.',
    priority: "medium" as const,
    status: "todo" as const,
  },
  {
    id: "seed-task-005",
    title: "Add CORS headers to the HTTP server",
    description:
      "No CORS headers are set on any response, so browser-based clients get blocked. Add `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` headers, and handle `OPTIONS` preflight requests.",
    priority: "high" as const,
    status: "todo" as const,
  },
  {
    id: "seed-task-006",
    title: "Write a proper README",
    description:
      'The current README just says "just do npm start". Replace it with a real README covering what the project does, how to set up env vars, how to run the seed, and how to start the server.',
    priority: "medium" as const,
    status: "todo" as const,
  },
];

async function main() {
  // 1. Seed dummy tasks
  for (const task of SEED_TASKS) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {},
      create: task,
    });
  }
  console.log(`[seed] Upserted ${SEED_TASKS.length} tasks`);

  const user = await prisma.user.upsert({
    where: { id: "seed-user-kaz" },
    update: {},
    create: {
      id: "seed-user-kaz",
      username: "kaz",
      passwordHash: KAZ_PASSWORD_HASH,
    },
  });
  console.log(`[seed] Upserted user "${user.username}"`);

  // 3. Create team "Default" with key "DEF"
  const team = await prisma.team.upsert({
    where: { id: "seed-team-default" },
    update: {},
    create: {
      id: "seed-team-default",
      name: "Default",
      key: "DEF",
    },
  });
  console.log(`[seed] Upserted team "${team.name}" (${team.key})`);

  // 4. Link kaz to Default team
  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: user.id } },
    update: {},
    create: {
      teamId: team.id,
      userId: user.id,
      role: "owner",
    },
  });
  console.log(`[seed] Upserted TeamMember kaz -> Default`);

  // 5. Check for an active repository
  const activeRepo = await prisma.repository.findFirst({
    where: { isActive: true },
  });
  console.log(
    activeRepo
      ? `[seed] Found active repository: ${activeRepo.fullName}`
      : `[seed] No active repository found`
  );

  // 6. Create project "OpenLinear"
  const project = await prisma.project.upsert({
    where: { id: "seed-project-openlinear" },
    update: {},
    create: {
      id: "seed-project-openlinear",
      name: "OpenLinear",
      leadId: user.id,
      ...(activeRepo ? { repositoryId: activeRepo.id } : {}),
    },
  });
  console.log(`[seed] Upserted project "${project.name}"`);

  // 7. Link project to team
  await prisma.projectTeam.upsert({
    where: {
      projectId_teamId: { projectId: project.id, teamId: team.id },
    },
    update: {},
    create: {
      projectId: project.id,
      teamId: team.id,
    },
  });
  console.log(`[seed] Upserted ProjectTeam OpenLinear -> Default`);

  // 8. Migrate orphan tasks into the project and team
  const migrated = await prisma.task.updateMany({
    where: { projectId: null },
    data: { projectId: project.id, teamId: team.id },
  });
  console.log(`[seed] Migrated ${migrated.count} orphan tasks into project`);
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
