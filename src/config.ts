import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { configPath, ensureAppHome } from "./paths.js";
import type { AppConfig } from "./types.js";

const defaults: AppConfig = {
  version: 1,
  github: {
    apiBaseUrl: "https://api.github.com",
  },
  account: {
    includePrivate: false,
    includeForks: false,
    includeArchived: false,
    includeOrganizations: false,
    exclude: [],
  },
  workbench: {
    port: 3789,
    syncMinutes: 15,
  },
};

function mergeConfig(value: Partial<AppConfig>): AppConfig {
  return {
    ...defaults,
    ...value,
    github: { ...defaults.github, ...value.github },
    account: { ...defaults.account, ...value.account },
    workbench: { ...defaults.workbench, ...value.workbench },
  };
}

export function readConfig(): AppConfig {
  ensureAppHome();
  if (!existsSync(configPath())) return structuredClone(defaults);
  const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<AppConfig>;
  return mergeConfig(raw);
}

export function saveConfig(config: AppConfig): void {
  ensureAppHome();
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    // Windows may not expose POSIX permissions; the home directory is still private.
  }
}

export function resolveToken(config = readConfig()): string | null {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || config.github.token || null;
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = mergeConfig({ ...readConfig(), ...patch });
  saveConfig(next);
  return next;
}

export function publicConfig(config = readConfig()): Record<string, unknown> {
  return {
    ...config,
    github: {
      ...config.github,
      token: config.github.token ? "<configured>" : null,
    },
  };
}
