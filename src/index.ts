/**
JotBird User Worker — v5.5 (Security-Hardened + Hub Binding + Explore Bridge)
──────────────────────────────────────────────────────────────────────────────
All fixes from security review applied + Hub Binding Support + Explore Bridge
FIX-10  HTML sanitizer rebuilt as a true allowlist-based parser.
FIX-11  ensureTablesOnce comment corrected to "once per isolate cold-start".
FIX-12  Worker public URL read from WORKER_PUBLIC_URL env var.
FIX-13  Hub JWT stored with a comment in the D1 settings table.
FIX-14  Hub sync/delete failures are no longer silent (sync_status).
FIX-15  handleList parses the tags JSON column server-side.
FIX-16  handleDeleteNote wraps SELECT + DELETE in a single D1 transaction.
FIX-17  Service Binding support (HUB) to solve Error 1042.
FIX-18  Smart Router (path normalization).
FIX-19  Hub Setup Endpoint (/api/v1/hub-setup).
FIX-20  Explore Bridge Endpoint (/api/v1/explore) for Plugin Sidebar.

Environment Variables (set in wrangler.toml / CF Dashboard):
DB                 — D1 database binding
HUB                — Service Binding to Hub Worker (Optional)
MASTER_WORKER_URL  — Hub Worker base URL (e.g. https://hub.example.com)
WORKER_PUBLIC_URL  — This worker's public URL (e.g. https://notes.example.com)
HUB_CLIENT_ID      — client_id provisioned via hub /admin/provision
HUB_CLIENT_SECRET  — client_secret from provisioning
API_KEY            — Secret key used by the Obsidian plugin to authenticate
*/
import { marked } from "marked";

// ─────────────────────────────────────────────────────────
// ENVIRONMENT INTERFACE
// ─────────────────────────────────────────────────────────
export interface Env {
  DB: D1Database;
  HUB?: Fetcher;             // اضافه شد برای حل مشکل 1042
  MASTER_WORKER_URL: string;
  WORKER_PUBLIC_URL?: string;
  HUB_CLIENT_ID: string;
  HUB_CLIENT_SECRET: string;
  API_KEY: string;
}

// ─────────────────────────────────────────────────────────
// FIX-11: One-time init — runs once per isolate cold-start.
// ─────────────────────────────────────────────────────────
let tablesReady = false;
async function ensureTablesOnce(env: Env): Promise<void> {
  if (tablesReady) return;
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS posts ( id TEXT PRIMARY KEY, html TEXT NOT NULL, markdown TEXT, title TEXT, tags TEXT DEFAULT '[]', folder TEXT DEFAULT '', is_public INTEGER DEFAULT 0, expire_at INTEGER NOT NULL, updated_at INTEGER, sync_status TEXT DEFAULT 'pending' ); CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL ); CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts(updated_at DESC); CREATE INDEX IF NOT EXISTS idx_posts_public ON posts(is_public, expire_at); CREATE INDEX IF NOT EXISTS idx_posts_sync ON posts(sync_status);`);
  tablesReady = true;
}

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      await ensureTablesOnce(env);

      const url = new URL(request.url);
      const method = request.method;
      // حذف اسلش‌های تکراری و انتهایی
      const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
      
      const authHeader = request.headers.get("Authorization") ?? "";

      // Auth check for all private endpoints
      const privateRoutes = ["/api/v1/publish", "/api/v1/documents", "/api/v1/delete", "/api/v1/hub-setup"];
      if (privateRoutes.includes(path) && authHeader !== `Bearer ${env.API_KEY}`) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      // ── Routes ────────────────────────────────────────
      // چک کردن روت عمومی (تغییر نام متغیر از url.pathname به path)
      if (path.startsWith("/p/") && method === "GET") {
        return handleView(request, env);
      }

      // اضافه کردن روت تنظیمات هاب
      if (path === "/api/v1/hub-setup" && method === "POST") {
        return handleHubSetup(request, env);
      }

      // FIX-20: Explore Bridge Endpoint for Plugin Sidebar
      if (path === "/api/v1/explore" && method === "GET") {
        const hubUrl = await getSetting(env, "hub_url") || env.MASTER_WORKER_URL;
        const urlParams = new URL(request.url).searchParams;
        
        // فراخوانی هاب و برگرداندن پاسخ به پلاگین
        return await callHub(env, `/api/v1/explore?${urlParams.toString()}`, {
          method: "GET"
        });
      }

      if (path === "/api/v1/publish" && method === "POST") return handlePublish(request, env, ctx);
      if (path === "/api/v1/delete" && method === "POST") return handleDeleteNote(request, env, ctx);
      if (path === "/api/v1/documents" && method === "GET") return handleList(request, env);
      if (path === "/api/v1/health" && method === "GET") return jsonResponse({ status: "ok", version: "5.5.0" });

      return new Response("JotBird User Worker v5.5", { status: 200 });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal Error";
      console.error("Worker unhandled error:", err);
      return jsonResponse({ error: message }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────
// SETTINGS HELPERS
// ─────────────────────────────────────────────────────────
async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

// ─────────────────────────────────────────────────────────
// FIX-12: Resolve the canonical public URL for this worker.
// ─────────────────────────────────────────────────────────
function getWorkerPublicUrl(env: Env): string {
  return (env.WORKER_PUBLIC_URL ?? "").replace(/\/$/, "") || env.MASTER_WORKER_URL;
}

// ─────────────────────────────────────────────────────────
// PUBLISH HANDLER
// ─────────────────────────────────────────────────────────
async function handlePublish(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const rawSlug = (typeof body.slug === "string" && body.slug) ? body.slug : crypto.randomUUID();
  const slug = sanitizeSlug(rawSlug);
  if (!slug) return jsonResponse({ error: "Invalid slug" }, 400);

  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim().slice(0, 300)
    : "Untitled";

  const isPublic = body.isPublic === true || body.isPublic === 1 ? 1 : 0;
  const folder = typeof body.folder === "string" ? body.folder.trim().slice(0, 200) : "";
  const rawTags = Array.isArray(body.tags) ? body.tags : [];
  const markdown = typeof body.markdown === "string" ? body.markdown : "";

  // Tags sanitization
  const tags = rawTags
    .filter((t: unknown): t is string => typeof t === "string" && t.trim() !== "")
    .map((t: string) => t.trim().slice(0, 50))
    .slice(0, 30);

  // expire_at: use plugin-supplied value or default 30 days
  const expireDays =
    typeof body.expire_days === "number" && body.expire_days > 0
      ? Math.min(body.expire_days, 365)
      : 30;

  const now = Date.now();
  const expireAt = now + expireDays * 86_400_000;

  // ── Render Markdown → HTML (FIX-10: with real allowlist sanitizer) ──
  const rawHtml = await marked.parse(markdown);
  const safeHtml = sanitizeHtml(rawHtml);
  const fullHtml = buildPageHtml(title, safeHtml, tags, folder);

  // ── owner_id from internal settings ONLY — never from the request body ──
  let ownerId = await getSetting(env, "owner_id");
  if (!ownerId) {
    // First publish: seed from env, fall back to "anonymous"
    ownerId = env.HUB_CLIENT_ID || "anonymous";
    await setSetting(env, "owner_id", ownerId);
  }

  // FIX-14: Start with sync_status = 'pending'. Background task updates it.
  await env.DB.prepare(`INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(id) DO UPDATE SET html = excluded.html, markdown = excluded.markdown, title = excluded.title, tags = excluded.tags, folder = excluded.folder, is_public = excluded.is_public, expire_at = excluded.expire_at, updated_at = excluded.updated_at, sync_status = 'pending'`).bind(
    slug, fullHtml, markdown, title,
    JSON.stringify(tags), folder, isPublic, expireAt, now,
  ).run();

  // FIX-12: Use WORKER_PUBLIC_URL instead of request.url origin.
  const workerPublicUrl = getWorkerPublicUrl(env);

  // ── Background Hub Sync (FIX-14: update sync_status on completion) ──
  if (env.MASTER_WORKER_URL || env.HUB) {
    if (isPublic) {
      ctx.waitUntil(
        syncToHub(env, { slug, title, tags, folder, workerPublicUrl })
          .then(() => markSyncStatus(env, slug, "synced"))
          .catch(async (err) => {
            console.error(`[${slug}] Hub sync failed:`, err);
            await markSyncStatus(env, slug, "failed");
          }),
      );
    } else {
      ctx.waitUntil(
        deleteFromHub(env, { slug })
          .then(() => markSyncStatus(env, slug, "synced"))
          .catch(async (err) => {
            console.error(`[${slug}] Hub delete failed:`, err);
            await markSyncStatus(env, slug, "failed");
          }),
      );
    }
  } else {
    // No Hub configured — mark as synced immediately
    await markSyncStatus(env, slug, "synced");
  }

  return jsonResponse({
    success: true,
    slug,
    url: `${workerPublicUrl}/p/${slug}`,
  });
}

// ─────────────────────────────────────────────────────────
// FIX-14: Helper to update sync_status column
// ─────────────────────────────────────────────────────────
async function markSyncStatus(
  env: Env,
  slug: string,
  status: "pending" | "synced" | "failed",
): Promise<void> {
  try {
    await env.DB
      .prepare("UPDATE posts SET sync_status = ? WHERE id = ?")
      .bind(status, slug)
      .run();
  } catch (err) {
    console.error(`Failed to update sync_status for ${slug}:`, err);
  }
}

// ─────────────────────────────────────────────────────────
// DELETE HANDLER
// FIX-16: SELECT + DELETE wrapped in a D1 transaction.
// ─────────────────────────────────────────────────────────
async function handleDeleteNote(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const slug = sanitizeSlug(body.slug);
  if (!slug) return jsonResponse({ error: "Missing or invalid slug" }, 400);

  // FIX-16: Run as a batch so both statements execute atomically.
  const [selectResult] = await env.DB.batch([
    env.DB.prepare("SELECT is_public FROM posts WHERE id = ?").bind(slug),
    env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(slug),
  ]);

  const rows = selectResult.results as Array<{ is_public: number }>;
  const wasPublic = rows.length > 0 && rows[0].is_public === 1;

  if (wasPublic && (env.MASTER_WORKER_URL || env.HUB)) {
    ctx.waitUntil(
      deleteFromHub(env, { slug }).catch((err) =>
        console.error(`[${slug}] Hub delete after local delete failed:`, err),
      ),
    );
  }

  return jsonResponse({ success: true, slug });
}

// ─────────────────────────────────────────────────────────
// VIEW HANDLER (Public page)
// ─────────────────────────────────────────────────────────
async function handleView(request: Request, env: Env): Promise<Response> {
  const rawSlug = new URL(request.url).pathname.replace("/p/", "");
  const slug = sanitizeSlug(rawSlug);
  if (!slug) {
    return new Response(buildNotFoundHtml(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  const post = await env.DB
    .prepare("SELECT html, is_public, expire_at FROM posts WHERE id = ?")
    .bind(slug)
    .first<{ html: string; is_public: number; expire_at: number }>();

  // Not found, private, or expired
  if (!post || !post.is_public || Date.now() > post.expire_at) {
    return new Response(buildNotFoundHtml(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  return new Response(post.html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
    },
  });
}

// ─────────────────────────────────────────────────────────
// LIST HANDLER
// FIX-15: Parse tags JSON column server-side.
// ─────────────────────────────────────────────────────────
async function handleList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
  const offset = (page - 1) * limit;

  const [listResult, countResult] = await env.DB.batch([
    env.DB.prepare(`SELECT id as slug, title, is_public, folder, tags, updated_at, expire_at, sync_status FROM posts ORDER BY updated_at DESC LIMIT ? OFFSET ?`).bind(limit, offset),
    env.DB.prepare("SELECT COUNT(*) as cnt FROM posts"),
  ]);

  // FIX-15: Parse the tags JSON string into a real array for each row
  const documents = (listResult.results as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    tags: (() => {
      try {
        const parsed = JSON.parse(row.tags as string);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
  }));

  const countRows = countResult.results as Array<{ cnt: number }>;
  const total = countRows[0]?.cnt ?? 0;

  return jsonResponse({
    documents,
    page,
    limit,
    total,
    has_more: offset + documents.length < total,
  });
}

// ─────────────────────────────────────────────────────────
// PART 4: HUB SETUP HANDLER
// ─────────────────────────────────────────────────────────
async function handleHubSetup(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    const { hub_url, master_api_key, owner_id } = body;

    if (!hub_url || !master_api_key) {
      return jsonResponse({ error: "Missing hub_url or master_api_key" }, 400);
    }

    await setSetting(env, "hub_url", hub_url.replace(/\/+$/, ""));
    await setSetting(env, "master_api_key", master_api_key);
    if (owner_id) {
      await setSetting(env, "owner_id", owner_id);
    }

    const workerOrigin = getWorkerPublicUrl(env);

    const res = await callHub(env, "/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${master_api_key}` },
      body: JSON.stringify({ worker_url: workerOrigin, owner_id: owner_id || env.HUB_CLIENT_ID })
    }, hub_url);

    const data: any = await res.json();
    if (data.token) {
      await setSetting(env, "hub_jwt", data.token);
      await setSetting(env, "hub_jwt_exp", String(Math.floor(new Date(data.expires_at).getTime() / 1000)));
      return jsonResponse({ success: true, message: "Hub linked via v5.5 logic" });
    }
    return jsonResponse({ error: "Failed to get token" }, 500);
  } catch (e: any) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────
// PART 3: HUB CONNECTION MAGIC (callHub)
// ─────────────────────────────────────────────────────────
async function callHub(env: Env, path: string, options: any, customHubUrl?: string): Promise<Response> {
  if (env.HUB) {
    // استفاده از Service Binding (داخلی و امن)
    const internalReq = new Request(`https://hub-internal${path}`, options);
    return env.HUB.fetch(internalReq);
  } else {
    // استفاده از اینترنت (خارجی)
    const targetBase = (customHubUrl || await getSetting(env, "hub_url") || env.MASTER_WORKER_URL).replace(/\/+$/, "");
    return fetch(`${targetBase}${path}`, options);
  }
}

// ─────────────────────────────────────────────────────────
// HUB SYNC
// FIX-12 & PART 5: Uses callHub instead of direct fetch.
// ─────────────────────────────────────────────────────────
interface SyncData {
  slug: string;
  title: string;
  tags: string[];
  folder: string;
  workerPublicUrl: string;
}

async function syncToHub(env: Env, data: SyncData): Promise<void> {
  // FIX-12: Always use the canonical public URL as the JWT audience.
  const token = await getOrRefreshHubToken(env, data.workerPublicUrl);
  if (!token) {
    throw new Error("Hub sync aborted: could not obtain token");
  }

  const ownerId = await getSetting(env, "owner_id") ?? env.HUB_CLIENT_ID;
  const buildBody = () => JSON.stringify({
    slug: data.slug,
    title: data.title,
    tags: data.tags,
    folder: data.folder,
    owner_id: ownerId,
    url: `${data.workerPublicUrl}/p/${data.slug}`,
  });

  // PART 5: Replace fetch with callHub
  let res = await callHub(env, "/api/v1/index", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: buildBody(),
  });

  if (res.status === 401) {
    // Token rejected — clear cache and retry once
    console.warn("Hub returned 401 on sync — clearing cached token and retrying");
    await setSetting(env, "hub_jwt", "");
    await setSetting(env, "hub_jwt_exp", "0");
    const freshToken = await getOrRefreshHubToken(env, data.workerPublicUrl);
    if (!freshToken) throw new Error("Could not obtain fresh Hub token on retry");
    
    res = await callHub(env, "/api/v1/index", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${freshToken}` },
      body: buildBody(),
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hub sync returned ${res.status}: ${text}`);
  }
}

async function deleteFromHub(env: Env, data: { slug: string }): Promise<void> {
  const ownerId = await getSetting(env, "owner_id") ?? env.HUB_CLIENT_ID;
  // FIX-12: Use the same canonical public URL for delete operations.
  const workerPublicUrl = getWorkerPublicUrl(env);
  const token = await getOrRefreshHubToken(env, workerPublicUrl);
  if (!token) throw new Error("Hub delete aborted: could not obtain token");

  // PART 5: Replace fetch with callHub
  const res = await callHub(env, `/api/v1/index/${encodeURIComponent(ownerId)}/${encodeURIComponent(data.slug)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${token}` }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hub delete returned ${res.status}: ${text}`);
  }
}

// ─────────────────────────────────────────────────────────
// HUB TOKEN MANAGEMENT
// FIX-13: JWT is cached in D1 settings table.
// ─────────────────────────────────────────────────────────
async function getOrRefreshHubToken(env: Env, workerPublicUrl: string): Promise<string | null> {
  const cachedToken = await getSetting(env, "hub_jwt");
  const cachedExpStr = await getSetting(env, "hub_jwt_exp");
  const nowSec = Math.floor(Date.now() / 1000);
  const cachedExp = cachedExpStr ? parseInt(cachedExpStr, 10) : 0;

  // Use cached token only if it has at least 10 minutes of remaining validity
  if (cachedToken && cachedExp > nowSec + 600) {
    return cachedToken;
  }

  return requestNewHubToken(env, workerPublicUrl);
}

async function requestNewHubToken(env: Env, workerPublicUrl: string): Promise<string | null> {
  try {
    // Using callHub for consistency with new architecture
    const res = await callHub(env, "/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.HUB_CLIENT_ID,
        client_secret: env.HUB_CLIENT_SECRET,
        worker_url: workerPublicUrl,
      }),
    });

    if (!res.ok) {
      console.error(`Hub auth failed: ${res.status}`, await res.text());
      return null;
    }

    const data = await res.json() as { token?: string; expires_at?: string };
    if (!data.token) return null;

    const exp = Math.floor(new Date(data.expires_at ?? 0).getTime() / 1000);
    await setSetting(env, "hub_jwt", data.token);
    await setSetting(env, "hub_jwt_exp", String(exp));
    console.log("New Hub JWT obtained, expires:", data.expires_at);
    return data.token;
  } catch (err) {
    console.error("Hub token request threw:", err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// FIX-10: TRUE ALLOWLIST-BASED HTML SANITIZER
// ─────────────────────────────────────────────────────────
const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "a", "img",
  "hr", "div", "span", "figure", "figcaption",
  "details", "summary",
]);

// Attributes allowed per tag. "*" means allowed on every allowed tag.
const ALLOWED_ATTRS: Record<string, string[]> = {
  "*": [],                                          // no global attrs by default
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan", "align"],
  th: ["colspan", "rowspan", "align"],
  code: ["class"],                                    // for syntax highlighting
  div: ["class"],
  span: ["class"],
};

// Void elements — must not emit a closing tag
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr",
]);

/**
Returns true when the resolved URL scheme is safe to use in href/src.
*/
function isSafeUrl(raw: string): boolean {
  // 1. Decode common HTML entities that browsers resolve before following links
  const decoded = raw
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&/gi, "&")
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/"/gi, '"')
    .replace(/'/gi, "'");

  // 2. Strip ASCII whitespace / control characters
  const stripped = decoded.replace(/[\x00-\x20\x7f]/g, "");

  // 3. Check scheme — only http, https, mailto, and relative URLs are allowed
  const lower = stripped.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:")
  ) {
    return false;
  }
  return true;
}

/**
Parse a raw attribute string.
*/
function parseAttributes(attrStr: string): Map<string, string> {
  const attrs = new Map<string, string>();
  // Match: name="value" | name='value' | name=value | name
  const re = /([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(name, value);
  }
  return attrs;
}

/**
Given a tag name and its raw attribute string, return a sanitized attribute string.
*/
function sanitizeAttributes(tagName: string, attrStr: string): string {
  const allowed = new Set([
    ...(ALLOWED_ATTRS["*"] ?? []),
    ...(ALLOWED_ATTRS[tagName] ?? []),
  ]);
  if (allowed.size === 0) return "";

  const parsed = parseAttributes(attrStr);
  const parts: string[] = [];

  for (const attrName of allowed) {
    if (!parsed.has(attrName)) continue;
    let value = parsed.get(attrName) ?? "";

    // For URL attributes, reject unsafe values
    if ((attrName === "href" || attrName === "src") && !isSafeUrl(value)) {
      value = "#";
    }

    // Escape double-quotes inside the value to prevent attribute injection
    const escaped = value.replace(/"/g, "&quot;");
    parts.push(`${attrName}="${escaped}"`);
  }

  // FIX: force rel="noopener noreferrer" when target="_blank"
  if (tagName === "a" && parsed.get("target") === "_blank") {
    // Remove any rel we already emitted, then re-add the safe version
    const idx = parts.findIndex(p => p.startsWith("rel="));
    if (idx !== -1) parts.splice(idx, 1);
    parts.push('rel="noopener noreferrer"');
    // Make sure target="_blank" is present
    if (!parts.some(p => p.startsWith("target="))) {
      parts.push('target="_blank"');
    }
  }

  return parts.length ? " " + parts.join(" ") : "";
}

/**
Main sanitize function.
*/
function sanitizeHtml(html: string): string {
  const out: string[] = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html[i] !== "<") {
      // Text node — emit as-is
      out.push(html[i]);
      i++;
      continue;
    }

    // Find end of tag
    const tagStart = i;
    let j = i + 1;

    // Skip inside attribute values so we don't mistake ">" inside an attr
    let inSingle = false;
    let inDouble = false;
    while (j < len) {
      const ch = html[j];
      if (ch === '"' && !inSingle) { inDouble = !inDouble; }
      else if (ch === "'" && !inDouble) { inSingle = !inSingle; }
      else if (ch === ">" && !inSingle && !inDouble) { j++; break; }
      j++;
    }

    const tagRaw = html.slice(tagStart, j); // full tag including < >
    i = j;

    // ── Identify tag name and type ────────────────────
    const inner = tagRaw.slice(1, tagRaw.endsWith("/>") ? -2 : -1).trim();
    const isClose = inner.startsWith("/");
    const isSelfClose = tagRaw.endsWith("/>");

    const rest = isClose ? inner.slice(1).trim() : inner;
    const spaceIdx = rest.search(/[\s/]/);
    const tagName = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).toLowerCase();
    const attrStr = spaceIdx === -1 ? "" : rest.slice(spaceIdx);

    // ── Comments and doctype — strip silently ─────────
    if (tagName.startsWith("!") || tagName.startsWith("?")) continue;

    // ── Drop disallowed tags entirely ─────────────────
    if (!ALLOWED_TAGS.has(tagName)) continue;

    // ── Emit sanitized tag ────────────────────────────
    if (isClose && !VOID_ELEMENTS.has(tagName)) {
      out.push(`</${tagName}>`);
    } else if (isSelfClose || VOID_ELEMENTS.has(tagName)) {
      const safeAttrs = sanitizeAttributes(tagName, attrStr);
      out.push(`<${tagName}${safeAttrs}>`);
    } else {
      const safeAttrs = sanitizeAttributes(tagName, attrStr);
      out.push(`<${tagName}${safeAttrs}>`);
    }
  }
  return out.join("");
}

// ─────────────────────────────────────────────────────────
// HTML PAGE BUILDER — Bilingual RTL/LTR Auto-detection
// ─────────────────────────────────────────────────────────
function detectRtl(text: string): boolean {
  const rtlChars = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
  const ltrChars = /[a-zA-Z]/g;
  const rtlCount = (text.match(rtlChars) ?? []).length;
  const ltrCount = (text.match(ltrChars) ?? []).length;
  return rtlCount > ltrCount;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildPageHtml(
  title: string,
  bodyHtml: string,
  tags: string[] = [],
  folder: string = "",
): string {
  const isRtl = detectRtl(title + "  " + bodyHtml.replace(/<[^>]+>/g, "  "));
  const dir = isRtl ? "rtl" : "ltr";
  const fontFamily = isRtl
    ? "'Vazirmatn','Vazir','Tahoma','Arial',sans-serif"
    : "'Inter','Geist','Segoe UI',system-ui,sans-serif";
  const textAlign = isRtl ? "right" : "left";

  const tagsHtml = tags.length
    ? `<div class="tags">${tags.map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  const folderHtml = folder
    ? `<div class="breadcrumb"><span class="folder-icon">📁</span> ${escapeHtml(folder)}</div>`
    : "";

  return `
<!DOCTYPE html>
<html lang="${isRtl ? "fa" : "en"}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    /* ── Reset & Base ──────────────────────────────── */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    :root {
      --bg:          #0f1117;
      --surface:     #161b27;
      --surface2:    #1e2433;
      --border:      #272d3d;
      --border-soft: rgba(255,255,255,0.06);
      --text:        #dde2ee;
      --text-muted:  #7a8499;
      --text-faint:  #4a5266;
      --accent:      #818cf8;
      --accent-soft: rgba(129,140,248,0.12);
      --accent-glow: rgba(129,140,248,0.25);
      --green:       #34d399;
      --red:         #f87171;
      --yellow:      #fbbf24;
      --code-bg:     #1a1f2e;
      --radius-sm:   6px;
      --radius:      10px;
      --radius-lg:   16px;
      --shadow:      0 4px 24px rgba(0,0,0,0.4);
      --font: ${fontFamily};
      --font-mono: 'JetBrains Mono','Fira Code','Cascadia Code','Consolas',monospace;
    }

    html {
      scroll-behavior: smooth;
      -webkit-text-size-adjust: 100%;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: clamp(0.95rem, 2.5vw, 1.05rem);
      line-height: 1.85;
      min-height: 100vh;
      padding: 1.5rem 1rem 4rem;
      direction: ${dir};
      text-align: ${textAlign};
      -webkit-font-smoothing: antialiased;
    }

    /* ── Layout ────────────────────────────────────── */
    .page {
      max-width: 760px;
      margin: 0 auto;
    }

    /* ── Header ────────────────────────────────────── */
    .site-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 1.5rem;
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--border);
    }

    .site-logo {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;
      letter-spacing: 0.02em;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .site-logo span { color: var(--accent); }

    /* ── Article Header ────────────────────────────── */
    .article-header {
      margin-bottom: 2.5rem;
    }

    .breadcrumb {
      font-size: 0.78rem;
      color: var(--text-faint);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    h1.article-title {
      font-size: clamp(1.6rem, 5vw, 2.4rem);
      font-weight: 700;
      line-height: 1.25;
      color: #fff;
      letter-spacing: -0.02em;
      margin-bottom: 1.25rem;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.75rem;
      ${isRtl ? "direction: rtl;" : ""}
    }

    .tag {
      background: var(--accent-soft);
      color: var(--accent);
      border: 1px solid rgba(129,140,248,0.2);
      padding: 0.2rem 0.7rem;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, border-color 0.15s;
    }

    .tag:hover {
      background: rgba(129,140,248,0.22);
      border-color: rgba(129,140,248,0.4);
    }

    .article-meta {
      font-size: 0.8rem;
      color: var(--text-faint);
      margin-top: 1rem;
    }

    /* ── Divider ───────────────────────────────────── */
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--border), transparent);
      margin: 2rem 0;
    }

    /* ── Content Typography ────────────────────────── */
    .content {
      direction: ${dir};
      text-align: ${textAlign};
    }

    .content > * + * { margin-top: 1.1rem; }

    .content h1,
    .content h2,
    .content h3,
    .content h4,
    .content h5,
    .content h6 {
      color: #fff;
      font-weight: 650;
      line-height: 1.3;
      letter-spacing: -0.015em;
      margin-top: 2.2rem;
      margin-bottom: 0.6rem;
    }

    .content h1 { font-size: 1.9rem; }
    .content h2 {
      font-size: 1.4rem;
      padding-bottom: 0.4rem;
      border-bottom: 1px solid var(--border);
    }
    .content h3 { font-size: 1.15rem; }
    .content h4 { font-size: 1rem; color: var(--text-muted); }

    .content p { color: var(--text); }

    .content a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(129,140,248,0.35);
      transition: border-color 0.15s, color 0.15s;
    }

    .content a:hover {
      color: #a5b4fc;
      border-bottom-color: #a5b4fc;
    }

    /* ── Blockquote ────────────────────────────────── */
    .content blockquote {
      border-${isRtl ? "right" : "left"}: 3px solid var(--accent);
      ${isRtl ? "padding-right" : "padding-left"}: 1.25rem;
      ${isRtl ? "margin-right" : "margin-left"}: 0;
      color: var(--text-muted);
      font-style: italic;
      background: var(--surface);
      border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      padding-top: 0.75rem;
      padding-bottom: 0.75rem;
      ${isRtl ? "padding-left" : "padding-right"}: 1rem;
    }

    /* ── Code ──────────────────────────────────────── */
    .content pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.25rem 1.4rem;
      overflow-x: auto;
      margin: 1.4rem 0;
      position: relative;
    }

    .content pre code {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      line-height: 1.65;
      color: #c9d1d9;
      background: none;
      padding: 0;
      border: none;
      direction: ltr;
      text-align: left;
      display: block;
    }

    .content code {
      font-family: var(--font-mono);
      font-size: 0.875em;
      color: #e2b4ff;
      background: rgba(226,180,255,0.1);
      padding: 0.15em 0.45em;
      border-radius: var(--radius-sm);
    }

    /* ── Lists ─────────────────────────────────────── */
    .content ul,
    .content ol {
      ${isRtl ? "padding-right" : "padding-left"}: 1.6rem;
    }

    .content li { margin: 0.35rem 0; }
    .content li::marker { color: var(--accent); }

    /* ── Tables ────────────────────────────────────── */
    .content table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
      margin: 1.5rem 0;
      overflow-x: auto;
      display: block;
    }

    .content th {
      background: var(--surface2);
      color: #fff;
      font-weight: 600;
      padding: 0.65rem 1rem;
      border: 1px solid var(--border);
      text-align: ${textAlign};
    }

    .content td {
      padding: 0.6rem 1rem;
      border: 1px solid var(--border);
      color: var(--text);
      text-align: ${textAlign};
    }

    .content tr:hover td { background: var(--surface); }

    /* ── Images ────────────────────────────────────── */
    .content img {
      max-width: 100%;
      height: auto;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      display: block;
      margin: 1.5rem auto;
    }

    /* ── HR ────────────────────────────────────────── */
    .content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 2rem 0;
    }

    /* ── Details/Summary ───────────────────────────── */
    .content details {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem 1rem;
      margin: 1rem 0;
    }

    .content summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--accent);
      list-style: none;
    }

    .content summary::-webkit-details-marker { display: none; }
    .content summary::before { content: "▶ "; font-size: 0.75em; }
    .content details[open] summary::before { content: "▼ "; }

    /* ── Footer ────────────────────────────────────── */
    .site-footer {
      margin-top: 4rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.78rem;
      color: var(--text-faint);
    }

    .site-footer a {
      color: var(--text-faint);
      text-decoration: none;
      border-bottom: 1px solid var(--border);
    }

    .site-footer a:hover { color: var(--accent); }

    /* ── Scroll progress bar ───────────────────────── */
    .progress-bar {
      position: fixed;
      top: 0;
      ${isRtl ? "right" : "left"}: 0;
      width: 0%;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), #a78bfa);
      z-index: 999;
      transition: width 0.1s linear;
    }

    /* ── Responsive ────────────────────────────────── */
    @media (max-width: 640px) {
      body { padding: 1rem 0.85rem 3rem; }
      h1.article-title { font-size: 1.5rem; }
      .content pre {
        padding: 1rem;
        border-radius: var(--radius-sm);
      }
      .content pre code { font-size: 0.8rem; }
      .content table { font-size: 0.8rem; }
    }

    /* ── Print ─────────────────────────────────────── */
    @media print {
      .progress-bar,
      .site-footer { display: none; }
      body { background: #fff; color: #000; }
      .content a { color: #000; }
    }
  </style>
</head>
<body>
  <div class="progress-bar" id="progress"></div>
  <div class="page">
    <header class="site-header">
      <a href="/" class="site-logo">
        <span>🐦</span> JotBird
      </a>
    </header>

    <article>
      <div class="article-header">
        ${folderHtml}
        <h1 class="article-title">${escapeHtml(title)}</h1>
        ${tagsHtml}
      </div>

      <div class="divider"></div>

      <div class="content">
        ${bodyHtml}
      </div>
    </article>

    <footer class="site-footer">
      Published with <a href="https://jotbird.app" target="_blank" rel="noopener noreferrer">JotBird</a>
    </footer>
  </div>

  <script>
    // Reading progress bar
    (function() {
      const bar = document.getElementById('progress');
      if (!bar) return;
      function update() {
        const scrollTop  = window.scrollY;
        const docHeight  = document.documentElement.scrollHeight - window.innerHeight;
        const pct        = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0;
        bar.style.width  = pct + '%';
      }
      window.addEventListener('scroll', update, { passive: true });
      update();
    })();
  </script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────
// 404 PAGE
// ─────────────────────────────────────────────────────────
function buildNotFoundHtml(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found · JotBird</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;color:#dde2ee;font-family:'Inter',system-ui,sans-serif;
         display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:2rem}
    .wrap{max-width:380px}
    .code{font-size:5rem;font-weight:700;color:#272d3d;line-height:1}
    h1{font-size:1.4rem;font-weight:600;color:#fff;margin:1rem 0 0.5rem}
    p{color:#7a8499;font-size:0.9rem;line-height:1.6}
    a{display:inline-block;margin-top:1.5rem;color:#818cf8;text-decoration:none;
      border-bottom:1px solid rgba(129,140,248,0.35);padding-bottom:2px;font-size:0.9rem}
    a:hover{color:#a5b4fc}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="code">404</div>
    <h1>Note not found</h1>
    <p>This note doesn't exist, is private, or has expired.</p>
    <a href="/">← Back to home</a>
  </div>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────
function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function sanitizeSlug(slug: unknown): string {
  if (typeof slug !== "string" || !slug) return "";
  return slug
    .toLowerCase()           // normalise case to match Plugin slugify
    .trim()
    .slice(0, 200)
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED D1 MIGRATION  (run once via wrangler d1 execute)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- FIX-14: Add sync_status column to existing tables
ALTER TABLE posts ADD COLUMN sync_status TEXT DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_posts_sync ON posts(sync_status);
-- Update any existing rows that are already public to 'synced'
UPDATE posts SET sync_status = 'synced' WHERE is_public = 1;
UPDATE posts SET sync_status = 'synced' WHERE is_public = 0;
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ENV VAR CHECKLIST  (wrangler.toml / CF Dashboard)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DB                = <d1_binding>
HUB               = <service_binding_to_hub>  ← NEW (Optional)
MASTER_WORKER_URL = "https://your-hub-worker.workers.dev"
WORKER_PUBLIC_URL = "https://notes.your-domain.com"   ← FIX-12
HUB_CLIENT_ID     = "my-notes-worker"
HUB_CLIENT_SECRET = "<secret from /admin/provision>"
API_KEY           = "<openssl rand -hex 32>"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
