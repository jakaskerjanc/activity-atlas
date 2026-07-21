// One-time local helper to obtain a Strava refresh_token.
//
// Usage:
//   STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... npm run auth
//
// Requires the Strava app's "Authorization Callback Domain" (strava.com/settings/api)
// to be set to: localhost
//
// Opens a local server, prints an authorize URL to visit, catches the redirect,
// exchanges the code, and prints the refresh_token to add as a repo secret.

import { createServer } from "node:http";

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "activity:read_all";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. Run: STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... npm run auth`);
    process.exit(1);
  }
  return v;
}

const clientId = requireEnv("STRAVA_CLIENT_ID");
const clientSecret = requireEnv("STRAVA_CLIENT_SECRET");

const authorizeUrl =
  `https://www.strava.com/oauth/authorize?client_id=${clientId}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code&approval_prompt=auto&scope=${SCOPE}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code in callback.");
    return;
  }

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });
    const json = (await tokenRes.json()) as { refresh_token?: string };
    if (!json.refresh_token) throw new Error(JSON.stringify(json));

    console.log("\n✅ Success! Add this as the STRAVA_REFRESH_TOKEN repo secret:\n");
    console.log(`   ${json.refresh_token}\n`);
    res.writeHead(200, { "Content-Type": "text/plain" })
      .end("Got the refresh token — check your terminal. You can close this tab.");
  } catch (err) {
    console.error("Token exchange failed:", err);
    res.writeHead(500).end("Token exchange failed — check your terminal.");
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser to authorize:\n");
  console.log(`   ${authorizeUrl}\n`);
});
