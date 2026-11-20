import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkbenchApp } from "../src/app.js";
import { Store } from "../src/db.js";
import { createMcpServer, WORKBENCH_URI } from "../src/mcp.js";
import type { GitHubClient } from "../src/github.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = {
  version: 1,
  github: { apiBaseUrl: "https://api.github.com" },
  account: {
    includePrivate: false,
    includeForks: false,
    includeArchived: false,
    includeOrganizations: false,
    exclude: [],
  },
  workbench: { port: 3789, syncMinutes: 15 },
};

describe("MCP contract", () => {
  it("exposes the workbench app, tools and resource", async () => {
    const store = new Store(":memory:");
    const app = new WorkbenchApp({
      config,
      store,
      client: { configured: false } as GitHubClient,
    });
    const server = createMcpServer(app);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const openTool = tools.tools.find((tool) => tool.name === "workbench_open");
    assert.ok(openTool);
    assert.deepEqual(openTool?._meta?.ui, { resourceUri: WORKBENCH_URI });
    assert.ok(tools.tools.some((tool) => tool.name === "workbench_scan"));
    assert.ok(tools.tools.some((tool) => tool.name === "task_commit_action"));

    const snapshot = await client.callTool({ name: "workbench_snapshot", arguments: {} });
    assert.equal((snapshot.structuredContent as { snapshot?: { configured?: boolean } } | undefined)?.snapshot?.configured, false);

    const resource = await client.readResource({ uri: WORKBENCH_URI });
    assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
    assert.ok(("text" in resource.contents[0]! ? resource.contents[0].text : "").includes("OSS Workbench"));

    await client.close();
    await server.close();
    store.close();
  });
});
