-- CreateEnum
CREATE TYPE "chat_message_roles" AS ENUM ('system', 'user', 'assistant', 'tool');

-- CreateEnum
CREATE TYPE "chat_tool_call_statuses" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "role" "chat_message_roles" NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_tool_calls" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" "chat_tool_call_statuses" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_userId_workspaceId_archivedAt_updatedAt_idx" ON "chat_sessions"("userId", "workspaceId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "chat_sessions_workspaceId_idx" ON "chat_sessions"("workspaceId");

-- CreateIndex
CREATE INDEX "chat_sessions_projectId_idx" ON "chat_sessions"("projectId");

-- CreateIndex
CREATE INDEX "chat_messages_sessionId_createdAt_idx" ON "chat_messages"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_userId_createdAt_idx" ON "chat_messages"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_tool_calls_sessionId_toolCallId_key" ON "chat_tool_calls"("sessionId", "toolCallId");

-- CreateIndex
CREATE INDEX "chat_tool_calls_sessionId_createdAt_idx" ON "chat_tool_calls"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_tool_calls_toolName_createdAt_idx" ON "chat_tool_calls"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "chat_tool_calls_userId_createdAt_idx" ON "chat_tool_calls"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_tool_calls_workspaceId_createdAt_idx" ON "chat_tool_calls"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tool_calls" ADD CONSTRAINT "chat_tool_calls_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "linear_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
