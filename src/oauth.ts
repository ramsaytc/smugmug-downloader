import crypto from "node:crypto";
import readline from "node:readline/promises";
import OAuth from "oauth-1.0a";
import { saveCredentials } from "./config.js";

const REQUEST_TOKEN_URL = "https://secure.smugmug.com/services/oauth/1.0a/getRequestToken";
const AUTHORIZE_URL = "https://secure.smugmug.com/services/oauth/1.0a/authorize";
const ACCESS_TOKEN_URL = "https://secure.smugmug.com/services/oauth/1.0a/getAccessToken";

function makeSigner(apiKey: string, apiSecret: string): OAuth {
  return new OAuth({
    consumer: { key: apiKey, secret: apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

function parseFormBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

/**
 * SmugMug's API uses the classic 3-legged OAuth 1.0a flow (same shape as
 * Twitter's original API). Since this is a CLI with no redirect URI, we use
 * the "oob" (out-of-band) callback: SmugMug shows the user a 6-digit code
 * after they approve access, which they paste back here.
 */
export async function login(apiKey: string, apiSecret: string): Promise<void> {
  const oauth = makeSigner(apiKey, apiSecret);

  const requestTokenAuth = oauth.authorize({
    url: REQUEST_TOKEN_URL,
    method: "GET",
    data: { oauth_callback: "oob" },
  });
  const res1 = await fetch(REQUEST_TOKEN_URL, { headers: { ...oauth.toHeader(requestTokenAuth) } });
  if (!res1.ok) {
    throw new Error(`Failed to get a request token: ${res1.status} ${await res1.text()}`);
  }
  const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } = parseFormBody(
    await res1.text()
  );
  if (!requestToken || !requestTokenSecret) {
    throw new Error("SmugMug did not return a request token. Double-check your API key/secret.");
  }

  const authorizeUrl = `${AUTHORIZE_URL}?oauth_token=${encodeURIComponent(requestToken)}&Access=Full&Permissions=Read`;
  console.log("\nOpen this URL in your browser and approve access for this tool:\n");
  console.log(`  ${authorizeUrl}\n`);
  console.log("SmugMug will display a 6-digit code once you approve.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const verifier = (await rl.question("Enter the code shown by SmugMug: ")).trim();
  rl.close();

  const token = { key: requestToken, secret: requestTokenSecret };
  const accessTokenAuth = oauth.authorize(
    { url: ACCESS_TOKEN_URL, method: "GET", data: { oauth_verifier: verifier } },
    token
  );
  const res2 = await fetch(ACCESS_TOKEN_URL, { headers: { ...oauth.toHeader(accessTokenAuth) } });
  if (!res2.ok) {
    throw new Error(`Failed to get an access token: ${res2.status} ${await res2.text()}`);
  }
  const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } = parseFormBody(
    await res2.text()
  );
  if (!accessToken || !accessTokenSecret) {
    throw new Error("SmugMug did not return an access token. The code may be wrong or expired — try again.");
  }

  saveCredentials({ apiKey, apiSecret, accessToken, accessTokenSecret });
  console.log("\nLogged in. Credentials saved to ~/.config/smugmug-dl/credentials.json");
}
