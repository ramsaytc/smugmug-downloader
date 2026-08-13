import crypto from "node:crypto";
import OAuth from "oauth-1.0a";
import type { Credentials } from "./config.js";

const API_ROOT = "https://api.smugmug.com";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin signed-fetch wrapper around SmugMug API v2. Endpoints are consumed via
 * the `Uris` links each response carries (SmugMug's API is hypermedia-driven),
 * so this client mostly just knows how to sign+GET whatever URI it's given
 * rather than hardcoding a route table.
 */
export class SmugMugClient {
  private oauth: OAuth;
  private token: { key: string; secret: string };

  constructor(creds: Credentials) {
    this.oauth = new OAuth({
      consumer: { key: creds.apiKey, secret: creds.apiSecret },
      signature_method: "HMAC-SHA1",
      hash_function(baseString, key) {
        return crypto.createHmac("sha1", key).update(baseString).digest("base64");
      },
    });
    this.token = { key: creds.accessToken, secret: creds.accessTokenSecret };
  }

  private resolve(pathOrUrl: string): string {
    return pathOrUrl.startsWith("http") ? pathOrUrl : `${API_ROOT}${pathOrUrl}`;
  }

  async get<T = any>(
    pathOrUrl: string,
    params: Record<string, string | number> = {},
    attempt = 1
  ): Promise<T> {
    const url = new URL(this.resolve(pathOrUrl));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const header = this.oauth.toHeader(this.oauth.authorize({ url: url.toString(), method: "GET" }, this.token));
    const res = await fetch(url.toString(), { headers: { ...header, Accept: "application/json" } });

    if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
      await sleep(Math.min(2 ** attempt * 500, 15_000));
      return this.get<T>(pathOrUrl, params, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`SmugMug API error ${res.status} for ${url}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}
