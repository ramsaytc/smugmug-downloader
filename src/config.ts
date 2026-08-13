import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

const CONFIG_DIR = join(homedir(), ".config", "smugmug-dl");
export const CONFIG_PATH = join(CONFIG_DIR, "credentials.json");

function loadCredentials(): Partial<Credentials> {
  let fromFile: Partial<Credentials> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      // malformed config file; treated as empty, missing fields reported below
    }
  }

  return {
    apiKey: process.env.SMUGMUG_API_KEY || fromFile.apiKey,
    apiSecret: process.env.SMUGMUG_API_SECRET || fromFile.apiSecret,
    accessToken: process.env.SMUGMUG_ACCESS_TOKEN || fromFile.accessToken,
    accessTokenSecret: process.env.SMUGMUG_ACCESS_TOKEN_SECRET || fromFile.accessTokenSecret,
  };
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function requireCredentials(): Credentials {
  const creds = loadCredentials();
  const missing = (["apiKey", "apiSecret", "accessToken", "accessTokenSecret"] as const).filter(
    (key) => !creds[key]
  );
  if (missing.length > 0) {
    console.error(
      `Missing SmugMug credentials: ${missing.join(", ")}.\n` +
        `Run "smugmug-dl login --api-key <key> --api-secret <secret>" first, or set ` +
        `SMUGMUG_API_KEY / SMUGMUG_API_SECRET / SMUGMUG_ACCESS_TOKEN / SMUGMUG_ACCESS_TOKEN_SECRET.`
    );
    process.exit(1);
  }
  return creds as Credentials;
}
