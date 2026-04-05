import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import * as client from "openid-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("[BOOT] MindVault server starting...");
console.log("[BOOT] Node version:", process.version);
console.log("[BOOT] Working directory:", process.cwd());
console.log("[BOOT] __dirname:", __dirname);

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

console.log("[CONFIG] PORT:", PORT);
console.log("[CONFIG] BASE_URL:", BASE_URL);
console.log("[CONFIG] OIDC_DISCOVERY_URL:", OIDC_DISCOVERY_URL);
console.log("[CONFIG] CLIENT_ID:", CLIENT_ID ? `${CLIENT_ID.slice(0, 6)}...` : "(NOT SET)");
console.log("[CONFIG] CLIENT_SECRET:", CLIENT_SECRET ? "(set)" : "(NOT SET)");
console.log("[CONFIG] SESSION_SECRET:", SESSION_SECRET === "mindvault-secret-change-me" ? "(default)" : "(custom)");
console.log("[CONFIG] STATIC_DIR:", STATIC_DIR);
console.log("[CONFIG] ALLOWED_USERS env:", process.env.ALLOWED_USERS || "(NOT SET)");

// Whitelist: comma-separated phone numbers and/or emails
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Validate required config (log errors but don't exit — let healthz work for K8s)
// ---------------------------------------------------------------------------
const configErrors = [];

if (!CLIENT_ID || !CLIENT_SECRET) {
  configErrors.push("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be set.");
}

if (ALLOWED_USERS.length === 0) {
  configErrors.push("ALLOWED_USERS must contain at least one email or phone.");
}

if (fs.existsSync(STATIC_DIR)) {
  const files = fs.readdirSync(STATIC_DIR);
  console.log(`[CONFIG] STATIC_DIR exists, contains ${files.length} items:`, files.slice(0, 20).join(", "), files.length > 20 ? "..." : "");
} else {
  configErrors.push(`Static directory not found: ${STATIC_DIR}. Run 'npx mintlify export' first, or set STATIC_DIR to the correct path.`);
  console.error(`[CONFIG] STATIC_DIR does NOT exist: ${STATIC_DIR}`);
}

if (configErrors.length > 0) {
  console.error(`[CONFIG] ${configErrors.length} config error(s) found — server will run in degraded mode (503 for all non-health routes)`);
  for (const err of configErrors) {
    console.error(`[CONFIG ERROR] ${err}`);
  }
} else {
  console.log("[CONFIG] All checks passed.");
}

// ---------------------------------------------------------------------------
// OIDC client setup
// ---------------------------------------------------------------------------
let oidcConfig;

async function getOIDCConfig() {
  if (oidcConfig) return oidcConfig;
  console.log("[OIDC] Discovering OIDC configuration from:", OIDC_DISCOVERY_URL);
  try {
    oidcConfig = await client.discovery(
      new URL(OIDC_DISCOVERY_URL),
      CLIENT_ID,
      CLIENT_SECRET,
    );
    console.log("[OIDC] Discovery successful. Issuer:", oidcConfig.serverMetadata().issuer);
  } catch (err) {
    console.error("[OIDC] Discovery FAILED:", err.message);
    throw err;
  }
  return oidcConfig;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.set("trust proxy", 1);

// Ensure X-Forwarded-Proto is set when behind a TLS-terminating proxy (e.g. K8s ingress).
// express-session refuses to set Secure cookies if req.secure is false.
if (BASE_URL.startsWith("https")) {
  app.use((req, _res, next) => {
    if (!req.headers["x-forwarded-proto"]) {
      req.headers["x-forwarded-proto"] = "https";
    }
    next();
  });
}

app.use(
  session({
    name: "mindvault.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: BASE_URL.startsWith("https"),
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

// ---------------------------------------------------------------------------
// Access log middleware
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const start = Date.now();
  const { method, originalUrl } = req;
  res.on("finish", () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    console.log(`[ACCESS] ${level} ${method} ${originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// ---------------------------------------------------------------------------
// Health check (unauthenticated, always responds even with config errors)
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => {
  console.log("[HEALTHZ] Health check requested");
  if (configErrors.length > 0) {
    console.log("[HEALTHZ] Responding: degraded");
    return res.send(`degraded: ${configErrors.join("; ")}`);
  }
  console.log("[HEALTHZ] Responding: ok");
  res.send("ok");
});

// ---------------------------------------------------------------------------
// Config guard: block all non-health routes if config is invalid
// ---------------------------------------------------------------------------
if (configErrors.length > 0) {
  app.use((req, res) => {
    console.log(`[503] Blocked request due to config errors: ${req.method} ${req.originalUrl}`);
    res.status(503).send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;">
          <div style="text-align:center;">
            <h1>503 Service Unavailable</h1>
            <p>Server configuration error. Check container logs.</p>
          </div>
        </body>
      </html>
    `);
  });
}

// ---------------------------------------------------------------------------
// Auth: login
// ---------------------------------------------------------------------------
app.get("/auth/login", async (req, res) => {
  console.log("[AUTH] Login initiated, returnTo:", req.session.returnTo || "/");
  try {
    const config = await getOIDCConfig();
    const redirectUri = `${BASE_URL}/auth/callback`;
    console.log("[AUTH] Redirect URI:", redirectUri);

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

    console.log("[AUTH] Redirecting to OIDC provider:", authUrl.origin + authUrl.pathname);
    // Explicitly save session before redirect to prevent race condition
    req.session.save((err) => {
      if (err) {
        console.error("[AUTH] Failed to save session before login redirect:", err);
        return res.status(500).send("Session error");
      }
      console.log("[AUTH] Session saved, session ID:", req.sessionID);
      res.redirect(authUrl.href);
    });
  } catch (err) {
    console.error("[AUTH] Login error:", err.message);
    console.error("[AUTH] Login error stack:", err.stack);
    res.status(500).send("Authentication service unavailable. Please try again later.");
  }
});

// ---------------------------------------------------------------------------
// Auth: callback
// ---------------------------------------------------------------------------
app.get("/auth/callback", async (req, res) => {
  console.log("[AUTH] Callback received, query params:", Object.keys(req.query).join(", "));
  console.log("[AUTH] Callback session ID:", req.sessionID);
  console.log("[AUTH] Callback session.oidc exists:", !!req.session.oidc);
  console.log("[AUTH] Callback session keys:", Object.keys(req.session).join(", "));
  console.log("[AUTH] Callback cookies:", req.headers.cookie || "(none)");
  try {
    const config = await getOIDCConfig();
    const { nonce, state, codeVerifier, redirectUri } = req.session.oidc || {};

    if (!nonce || !state || !codeVerifier) {
      console.warn("[AUTH] Callback missing OIDC session data (nonce/state/codeVerifier), redirecting to login");
      console.warn("[AUTH] Session contents:", JSON.stringify(req.session, null, 2));
      return res.redirect("/auth/login");
    }

    // openid-client v6 expects a URL for the current request
    const currentUrl = new URL(req.originalUrl, BASE_URL);
    console.log("[AUTH] Exchanging authorization code, currentUrl:", currentUrl.toString());

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      expectedNonce: nonce,
      expectedState: state,
      pkceCodeVerifier: codeVerifier,
      idTokenExpected: true,
    });
    console.log("[AUTH] Token exchange successful");

    const claims = tokens.claims();
    console.log("[AUTH] ID token claims sub:", claims.sub);

    // Also try userinfo for more claims (phone, etc.)
    let userinfo = {};
    try {
      userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
      console.log("[AUTH] UserInfo fetched, keys:", Object.keys(userinfo).join(", "));
    } catch (e) {
      console.warn("[AUTH] UserInfo fetch failed (non-fatal):", e.message);
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

    console.log("[AUTH] User identifiers:", identifiers.join(", "));
    const isAllowed = identifiers.some((id) => ALLOWED_USERS.includes(id));
    console.log("[AUTH] Access allowed:", isAllowed);

    if (!isAllowed) {
      // Clean up session
      delete req.session.oidc;
      delete req.session.user;
      console.warn(
        `[AUTH] Access DENIED for user: ${merged.sub} (identifiers: ${identifiers.join(", ")})`,
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
      picture: merged.picture || null,
    };
    delete req.session.oidc;

    const returnTo = req.session.returnTo || "/";
    delete req.session.returnTo;
    console.log("[AUTH] Login successful for:", merged.email || merged.sub, "-> redirecting to:", returnTo);
    // Explicitly save session before redirect to ensure user data persists
    req.session.save((err) => {
      if (err) {
        console.error("[AUTH] Failed to save session after login:", err);
        return res.status(500).send("Session error");
      }
      console.log("[AUTH] Session saved after login, session ID:", req.sessionID);
      res.redirect(returnTo);
    });
  } catch (err) {
    console.error("[AUTH] Callback error:", err.message);
    console.error("[AUTH] Callback error stack:", err.stack);
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
  console.log(`[AUTH] Unauthenticated request: ${req.method} ${req.originalUrl} -> redirecting to /auth/login`);
  req.session.returnTo = req.originalUrl;
  req.session.save((err) => {
    if (err) console.error("[AUTH] Failed to save returnTo:", err);
    res.redirect("/auth/login");
  });
});

// ---------------------------------------------------------------------------
// User menu injection snippet (injected before </body> in HTML responses)
// ---------------------------------------------------------------------------
const userMenuSnippet = `
<style>
  .mv-user-menu{position:fixed;top:16px;right:16px;z-index:99999;font-family:system-ui,-apple-system,sans-serif}
  .mv-avatar{width:36px;height:36px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:border-color .2s;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#fff;background:#6366f1;overflow:hidden;user-select:none}
  .mv-avatar:hover{border-color:#6366f1}
  .mv-avatar img{width:100%;height:100%;object-fit:cover}
  .mv-dropdown{position:absolute;top:44px;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);min-width:160px;opacity:0;visibility:hidden;transform:translateY(-4px);transition:all .15s ease}
  .mv-user-menu:hover .mv-dropdown,.mv-dropdown.mv-show{opacity:1;visibility:visible;transform:translateY(0)}
  .mv-dropdown a{display:flex;align-items:center;gap:8px;padding:10px 16px;color:#374151;text-decoration:none;font-size:14px;transition:background .15s}
  .mv-dropdown a:first-child{border-radius:8px 8px 0 0}
  .mv-dropdown a:last-child{border-radius:0 0 8px 8px}
  .mv-dropdown a:hover{background:#f3f4f6}
  .mv-dropdown .mv-divider{border-top:1px solid #e5e7eb;margin:0}
  @media(prefers-color-scheme:dark){
    .mv-dropdown{background:#1f2937;border-color:#374151}
    .mv-dropdown a{color:#e5e7eb}
    .mv-dropdown a:hover{background:#374151}
    .mv-dropdown .mv-divider{border-color:#374151}
  }
</style>
<script>
(function(){
  fetch('/auth/me').then(r=>r.ok?r.json():null).then(u=>{
    if(!u)return;
    var d=document.createElement('div');d.className='mv-user-menu';
    var name=u.name||u.email||'U';
    var initials=name.charAt(0).toUpperCase();
    var avatarInner=u.picture?'<img src="'+u.picture+'" alt="avatar">':initials;
    d.innerHTML='<div class="mv-avatar">'+avatarInner+'</div>'
      +'<div class="mv-dropdown">'
      +'<a href="https://accounts.appforges.com" target="_blank">'
      +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
      +'用户中心</a>'
      +'<div class="mv-divider"></div>'
      +'<a href="/auth/logout">'
      +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
      +'退出登录</a>'
      +'</div>';
    document.body.appendChild(d);
  });

})();
</script>`;

function injectUserMenu(html) {
  if (html.includes("</body>")) {
    return html.replace("</body>", userMenuSnippet + "</body>");
  }
  return html + userMenuSnippet;
}

// ---------------------------------------------------------------------------
// Resolve HTML file path: try exact, .html extension, and /index.html
// ---------------------------------------------------------------------------
function resolveHtmlFile(reqPath) {
  const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidates = [
    path.join(STATIC_DIR, safePath),
    path.join(STATIC_DIR, safePath + ".html"),
    path.join(STATIC_DIR, safePath, "index.html"),
  ];
  for (const p of candidates) {
    if (p.endsWith(".html") && fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serve static Mintlify site (with user menu injection for HTML)
// ---------------------------------------------------------------------------
// Check if request is a browser page navigation (not XHR/fetch/asset)
function isPageNavigation(req) {
  const accept = req.headers.accept || "";
  return accept.includes("text/html");
}

// Mintlify dev-only endpoints — return empty responses to avoid 404 noise
app.get("/_mintlify/api/user", (_req, res) => res.json(null));
app.use("/socket.io", (_req, res) => res.status(204).end());

// Serve static assets (JS, CSS, images, fonts, etc.)
app.use(express.static(STATIC_DIR));

// Resolve HTML file path: try exact, .html extension, and /index.html
// (mirrors Mintlify serve.js behavior)
app.use((req, res, next) => {
  if (req.method !== "GET") return next();

  // Skip non-page requests
  if (req.path.startsWith("/_next/") || req.path.startsWith("/_mintlify/")) return next();
  const ext = path.extname(req.path);
  if (ext && ext !== ".html") return next();

  // Try to find an actual HTML file (e.g. /foo → /foo.html or /foo/index.html)
  const htmlFile = resolveHtmlFile(req.path);
  if (htmlFile) {
    const html = fs.readFileSync(htmlFile, "utf-8");
    return res.type("html").send(isPageNavigation(req) ? injectUserMenu(html) : html);
  }
  next();
});

// SPA fallback: serve index.html for browser page navigations only
const indexPath = path.join(STATIC_DIR, "index.html");
const indexHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null;
const indexHtmlWithMenu = indexHtml ? injectUserMenu(indexHtml) : null;

app.use((req, res) => {
  if (!indexHtml) {
    return res.status(404).send("Not found");
  }
  // Only serve SPA fallback for browser page navigations
  if (isPageNavigation(req)) {
    return res.type("html").send(indexHtmlWithMenu);
  }
  res.status(404).end();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[BOOT] MindVault server listening on port ${PORT}`);
  console.log(`[BOOT] Config errors: ${configErrors.length}`);
  console.log(`[BOOT] ALLOWED_USERS count: ${ALLOWED_USERS.length} -> [${ALLOWED_USERS.join(", ")}]`);
  console.log(`[BOOT] Static dir: ${STATIC_DIR}`);
  console.log(`[BOOT] Server ready.`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[ERROR] Port ${PORT} is already in use.`);
  } else {
    console.error(`[ERROR] Failed to start server: ${err.message}`);
  }
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err.message);
  console.error("[FATAL] Stack:", err.stack);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});
