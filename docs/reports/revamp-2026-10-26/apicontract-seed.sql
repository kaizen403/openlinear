-- Task-list benchmark seed (apicontract, W14). Local, disposable databases only.
--
--   createdb -h 127.0.0.1 -p 54330 -U openlinear openlinear_apicontract_bench
--   DATABASE_URL=… pnpm --filter @openlinear/db exec prisma migrate deploy
--   psql -h 127.0.0.1 -p 54330 -U openlinear -d openlinear_apicontract_bench -f apicontract-seed.sql
--
-- Shape: 200 users, 51 workspaces, 120 projects (one team each), 720 labels,
-- ~198 000 tasks. The bench user (user 0) owns workspace 0 (20 projects:
-- one 60 000-task board, 19 × 2 000) and is a member of workspaces 1–5; the
-- other 45 workspaces (2 projects × 1 000 tasks) are invisible to it.
-- 10 % archived, 60 % assigned, 20 % sub-issues, 0–2 labels per task,
-- createdAt truncated to the second over two years (ties exercise the id
-- tiebreak). Ids are deterministic UUIDs: md5('<kind>:<n>')::uuid.

BEGIN;

CREATE TEMP TABLE bench_projects AS
SELECT p AS n,
       md5('project:' || p)::uuid::text AS id,
       md5('team:' || p)::uuid::text AS team_id,
       CASE WHEN p < 20 THEN 0 ELSE 1 + (p - 20) / 2 END AS ws,
       CASE WHEN p = 0 THEN 60000 WHEN p < 20 THEN 2000 ELSE 1000 END AS task_count
FROM generate_series(0, 119) AS p;

-- Global task numbering: each project gets a contiguous block.
ALTER TABLE bench_projects ADD COLUMN first_task integer;
UPDATE bench_projects b SET first_task = s.first_task
FROM (SELECT n, COALESCE(SUM(task_count) OVER (ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS first_task
      FROM bench_projects) s
WHERE s.n = b.n;

INSERT INTO users (id, "githubId", username, email, "createdAt", "updatedAt")
SELECT md5('user:' || u)::uuid::text, 'bench-' || u, 'bench-user-' || u, 'bench-' || u || '@example.com', now(), now()
FROM generate_series(0, 199) AS u;

INSERT INTO workspaces (id, name, slug, "createdAt", "updatedAt")
SELECT md5('workspace:' || w)::uuid::text, 'Bench ' || w, 'bench-' || w, now(), now()
FROM generate_series(0, 50) AS w;

-- Workspace 0: user 0 owner + users 1–20; workspaces 1–50: four users each
-- (user 0 also joins 1–5).
INSERT INTO workspace_members (id, "workspaceId", "userId", role, "joinedAt")
SELECT md5('wm:0:' || u)::uuid::text, md5('workspace:0')::uuid::text, md5('user:' || u)::uuid::text,
       CASE WHEN u = 0 THEN 'owner'::workspace_roles ELSE 'member'::workspace_roles END, now()
FROM generate_series(0, 20) AS u;
INSERT INTO workspace_members (id, "workspaceId", "userId", role, "joinedAt")
SELECT md5('wm:' || w || ':k' || k)::uuid::text, md5('workspace:' || w)::uuid::text,
       md5('user:' || (21 + ((w - 1) * 4 + k) % 179))::uuid::text, 'member'::workspace_roles, now()
FROM generate_series(1, 50) AS w, generate_series(0, 3) AS k;
INSERT INTO workspace_members (id, "workspaceId", "userId", role, "joinedAt")
SELECT md5('wm:' || w || ':bench')::uuid::text, md5('workspace:' || w)::uuid::text, md5('user:0')::uuid::text,
       'member'::workspace_roles, now()
FROM generate_series(1, 5) AS w;

INSERT INTO linear_projects (id, name, status, color, "createdAt", "updatedAt", "workspaceId", key)
SELECT id, 'Bench project ' || n, 'in_progress', '#6366f1', now(), now(), md5('workspace:' || ws)::uuid::text, 'BP' || n
FROM bench_projects;

INSERT INTO teams (id, name, key, color, "nextIssueNumber", "createdAt", "updatedAt", project_id)
SELECT team_id, 'Bench team ' || n, 'BT' || n, '#6366f1', task_count + 1, now(), now(), id
FROM bench_projects;

-- Team membership mirrors workspace membership.
INSERT INTO team_members (id, "teamId", "userId", role)
SELECT md5('tm:' || p.n || ':' || wm."userId")::uuid::text, p.team_id, wm."userId",
       CASE WHEN wm.role = 'owner' THEN 'owner'::team_roles ELSE 'member'::team_roles END
FROM bench_projects p
JOIN workspace_members wm ON wm."workspaceId" = md5('workspace:' || p.ws)::uuid::text;

INSERT INTO labels (id, name, color, priority, "projectId")
SELECT md5('label:' || p.n || ':' || l)::uuid::text, 'label-' || l, '#22c55e', l, p.id
FROM bench_projects p, generate_series(0, 5) AS l;

INSERT INTO tasks (id, title, description, priority, status, "createdAt", "updatedAt", archived,
                   "teamId", "projectId", number, identifier, "assigneeId", "creatorId", "parentId", "workspaceId")
SELECT md5('task:' || t.g)::uuid::text,
       'Task ' || t.g || ' ' || (ARRAY['fix login bug', 'add export', 'refactor parser', 'update docs', 'improve search', 'billing webhook'])[1 + t.g % 6],
       repeat('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ', 3) || 'ref-' || t.g,
       (ARRAY['low', 'medium', 'high']::"Priority"[])[1 + t.g % 3],
       CASE WHEN t.r < 0.30 THEN 'todo'::"Status" WHEN t.r < 0.40 THEN 'in_progress'::"Status"
            WHEN t.r < 0.95 THEN 'done'::"Status" ELSE 'cancelled'::"Status" END,
       date_trunc('second', timestamp '2024-10-01' + (t.i::double precision / p.task_count) * interval '730 days'),
       now(),
       (t.g % 10 = 3),
       p.team_id, p.id, t.i + 1, 'BT' || p.n || '-' || (t.i + 1),
       CASE WHEN t.g % 5 < 3 THEN
         CASE WHEN p.ws = 0 THEN md5('user:' || (t.g % 21))::uuid::text
              ELSE md5('user:' || (21 + ((p.ws - 1) * 4 + t.g % 4) % 179))::uuid::text END
       END,
       CASE WHEN p.ws = 0 THEN md5('user:' || (t.g % 7))::uuid::text
            ELSE md5('user:' || (21 + ((p.ws - 1) * 4) % 179))::uuid::text END,
       CASE WHEN t.g % 5 = 4 AND t.i >= 10 THEN md5('task:' || (t.g - 1 - (t.g % 10)))::uuid::text END,
       md5('workspace:' || p.ws)::uuid::text
FROM bench_projects p,
     LATERAL (SELECT i, p.first_task + i AS g, ((p.first_task + i) * 2654435761 % 1000)::double precision / 1000 AS r
              FROM generate_series(0, p.task_count - 1) AS i) AS t;

INSERT INTO task_labels ("taskId", "labelId")
SELECT md5('task:' || (p.first_task + i))::uuid::text, md5('label:' || p.n || ':' || ((p.first_task + i + k) % 6))::uuid::text
FROM bench_projects p, generate_series(0, p.task_count - 1) AS i, generate_series(0, 1) AS k
WHERE k < (p.first_task + i) % 3;

COMMIT;

ANALYZE users; ANALYZE workspaces; ANALYZE workspace_members; ANALYZE linear_projects;
ANALYZE teams; ANALYZE team_members; ANALYZE labels; ANALYZE tasks; ANALYZE task_labels;
