#!/usr/bin/env bun
import { createOpencode } from "@opencode-ai/sdk";

async function testSDK() {
  console.log("=== OpenCode SDK Spike Test ===\n");

  console.log("1. Creating OpenCode server and client...");
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port: 4096,
    timeout: 10000,
  });
  console.log("   ✓ Server started at:", server.url);
  console.log("   ✓ Client created successfully");
  console.log("   Available namespaces:", Object.keys(client).join(", "));

  try {
    console.log("\n2. Testing client.session.list()...");
    const sessions = await client.session.list();
    console.log("   ✓ Sessions response:", sessions.data ? "OK" : "No data");
    if (sessions.data) {
      console.log("   Sessions count:", sessions.data.length);
    }

    console.log("\n3. Testing client.project.current()...");
    const project = await client.project.current();
    console.log("   ✓ Project response:", project.data ? "OK" : "No data");
    if (project.data) {
      console.log("   Project worktree:", project.data.worktree);
    }

    console.log("\n4. Testing client.config.get()...");
    const config = await client.config.get();
    console.log("   ✓ Config response:", config.data ? "OK" : "No data");

    console.log("\n5. Testing client.config.providers()...");
    const providers = await client.config.providers();
    console.log("   ✓ Providers response:", providers.data ? "OK" : "No data");
    if (providers.data) {
      console.log(
        "   Providers:",
        providers.data.providers.map((p) => p.id).join(", ")
      );
    }

    console.log("\n=== All tests passed! ===");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    console.log("\nClosing server...");
    server.close();
  }
}

testSDK();
