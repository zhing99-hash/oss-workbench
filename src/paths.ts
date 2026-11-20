import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function appHome(): string {
  return process.env.OSS_WORKBENCH_HOME || join(homedir(), ".oss-workbench");
}

export function ensureAppHome(): string {
  const home = appHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

export function configPath(): string {
  return join(appHome(), "config.json");
}

export function databasePath(): string {
  return join(appHome(), "data.db");
}

export function auditPath(): string {
  return join(appHome(), "audit.jsonl");
}

export function packageRoot(): string {
  return join(import.meta.dirname, "..");
}

export function builtWorkbenchHtml(): string {
  return join(packageRoot(), "dist", "ui", "workbench.html");
}
