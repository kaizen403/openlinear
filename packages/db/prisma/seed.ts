import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  for (const task of SEED_TASKS) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {},
      create: task,
    });
  }

  console.log(`[seed] Upserted ${SEED_TASKS.length} tasks`);
}

main()
  .catch((e) => {
    console.error("[seed] Failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
