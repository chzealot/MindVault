import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import * as client from "openid-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration (runtime, from .env or environment variables)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ||
  "https://accounts.appforges.com/.well-known/openid-configuration";
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || "mindvault-secret-change-me";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "../.mintlify/output");

// Whitelist: comma-separated phone numbers and/or emails
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Validate required config
// ---------------------------------------------------------------------------
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set.");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error("ERROR: ALLOWED_USERS must contain at least one email or phone.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// OIDC client setup
// ---------------------------------------------------------------------------
let oidcConfig;

async function getOIDCConfig() {
  if (oidcConfig) return oidcConfig;
  oidcConfig = await client.discovery(
    new URL(OIDC_DISCOVERY_URL),
    CLIENT_ID,
    CLIENT_SECRET,
  );
  return oidcConfig;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.set("trust proxy", 1);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: BASE_URL.startsWith("https"),
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

// ---------------------------------------------------------------------------
// Health check (unauthenticated)
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => res.send("ok"));

// ---------------------------------------------------------------------------
// Auth: login
// ---------------------------------------------------------------------------
app.get("/auth/login", async (req, res) => {
  try {
    const config = await getOIDCConfig();
    const redirectUri = `${BASE_URL}/auth/callback`;

    const nonce = client.randomNonce();
    const state = client.randomState();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    req.session.oidc = { nonce, state, codeVerifier, redirectUri };

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email phone",
      response_type: "code",
      nonce,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    res.redirect(authUrl.href);
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Authentication service unavailable. Please try again later.");
  }
});

// ---------------------------------------------------------------------------
// Auth: callback
// ---------------------------------------------------------------------------
app.get("/auth/callback", async (req, res) => {
  try {
    const config = await getOIDCConfig();
    const { nonce, state, codeVerifier, redirectUri } = req.session.oidc || {};

    if (!nonce || !state || !codeVerifier) {
      return res.redirect("/auth/login");
    }

    // openid-client v6 expects a URL for the current request
    const currentUrl = new URL(req.originalUrl, BASE_URL);

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      expectedNonce: nonce,
      expectedState: state,
      pkceCodeVerifier: codeVerifier,
      idTokenExpected: true,
    });

    const claims = tokens.claims();

    // Also try userinfo for more claims (phone, etc.)
    let userinfo = {};
    try {
      userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
    } catch {
      // userinfo endpoint may not be available, continue with id_token claims
    }

    const merged = { ...claims, ...userinfo };

    // Extract identifiers for whitelist check
    const identifiers = [
      merged.email,
      merged.phone_number,
      merged.phone,
      merged.preferred_username,
    ]
      .filter(Boolean)
      .map((s) => s.toLowerCase());

    const isAllowed = identifiers.some((id) => ALLOWED_USERS.includes(id));

    if (!isAllowed) {
      // Clean up session
      delete req.session.oidc;
      delete req.session.user;
      console.warn(
        `Access denied for user: ${merged.sub} (identifiers: ${identifiers.join(", ")})`,
      );
      return res.status(403).send(`
        <html>
          <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;">
            <div style="text-align:center;">
              <h1>403 Access Denied</h1>
              <p>Your account is not in the allowed users list.</p>
              <a href="/auth/logout">Back</a>
            </div>
          </body>
        </html>
      `);
    }

    // Store user in session
    req.session.user = {
      sub: merged.sub,
      email: merged.email,
      phone: merged.phone_number || merged.phone,
      name: merged.name || merged.preferred_username,
    };
    delete req.session.oidc;

    res.redirect(req.session.returnTo || "/");
    delete req.session.returnTo;
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Authentication failed. Please try again.");
  }
});

// ---------------------------------------------------------------------------
// Auth: logout
// ---------------------------------------------------------------------------
app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// ---------------------------------------------------------------------------
// Auth: user info API
// ---------------------------------------------------------------------------
app.get("/auth/me", (req, res) => {
  if (req.session.user) {
    return res.json(req.session.user);
  }
  res.status(401).json({ error: "not authenticated" });
});

// ---------------------------------------------------------------------------
// Auth guard for all other routes
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.session.user) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect("/auth/login");
});

// ---------------------------------------------------------------------------
// Serve static Mintlify site
// ---------------------------------------------------------------------------
app.use(express.static(STATIC_DIR));

// SPA fallback: serve index.html for unmatched routes
app.use((_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`MindVault server running on port ${PORT}`);
  console.log(`OIDC discovery: ${OIDC_DISCOVERY_URL}`);
  console.log(`Allowed users: ${ALLOWED_USERS.join(", ")}`);
  console.log(`Static dir: ${STATIC_DIR}`);
});
