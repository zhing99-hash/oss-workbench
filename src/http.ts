import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WorkbenchApp } from "./app.js";
import { ActionError, cancelAction, commitAction, prepareAction } from "./actions.js";
import { createMcpServer } from "./mcp.js";
import type { ActionRequest } from "./types.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new ActionError("请求体过大。", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function allowedOrigin(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === String(port);
  } catch {
    return false;
  }
}

export interface HttpServerResult {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(
  app: WorkbenchApp,
  options: { port?: number; openBrowser?: boolean } = {},
): Promise<HttpServerResult> {
  const port = options.port ?? app.config.workbench.port;

  const server = createServer(async (req, res) => {
    try {
      if (!allowedOrigin(req, port)) {
        json(res, 403, { error: "Origin not allowed." });
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/workbench")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self' 'unsafe-inline'; connect-src 'self'; img-src https: data:; frame-ancestors 'none'",
        });
        res.end(app.workbenchHtml());
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, configured: app.configured, syncedAt: app.lastSyncAt() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        json(res, 200, app.snapshot());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/audit") {
        json(res, 200, { records: app.store.listAudit(50) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/scan") {
        const payload = await body(req);
        if (!app.configured) {
          json(res, 401, { error: app.setupMessage() });
          return;
        }
        const sync = await app.sync(payload.force !== false);
        json(res, 200, { sync, snapshot: app.snapshot() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/prepare") {
        const payload = await body(req);
        const prepared = prepareAction(app.store, payload as unknown as ActionRequest);
        json(res, 200, prepared);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/commit") {
        const payload = await body(req);
        if (payload.confirm !== true) {
          json(res, 400, { error: "必须明确确认操作。" });
          return;
        }
        const committed = await commitAction(app.store, app.client, String(payload.actionId ?? ""));
        json(res, 200, committed);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const payload = await body(req);
        cancelAction(app.store, String(payload.actionId ?? ""));
        json(res, 200, { cancelled: true });
        return;
      }
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          json(res, 405, { error: "Use POST for stateless Streamable HTTP MCP." });
          return;
        }
        const payload = await body(req);
        const mcp = createMcpServer(app);
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, payload);
        return;
      }
      json(res, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof ActionError ? error.status : 500;
      json(res, status, { error: (error as Error).message || "Unknown error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}/workbench`;
  if (options.openBrowser) openBrowser(url);

  return {
    url,
    port: actualPort,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}
