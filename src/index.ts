import { marked } from "marked";

export interface Env {
  DB: D1Database;
  MASTER_WORKER_URL: string; // آدرس هاب (مقدار اولیه)
  MASTER_API_KEY: string;    // کلید هاب (مقدار اولیه)
  API_KEY: string;           // کلید اختصاصی پلاگین <-> ورکر
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authHeader = request.headers.get("Authorization") ?? "";

      // ── روت عمومی: مشاهده نوت ──
      if (url.pathname.startsWith("/p/")) {
        return handleView(request, env);
      }

      // ── احراز هویت برای تمام مسیرهای API ──
      if (url.pathname.startsWith("/api/v1/")) {
        if (authHeader !== `Bearer ${env.API_KEY}`) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
      }

      // ── مسیرهای عملیاتی ──
      if (url.pathname === "/api/v1/hub-setup" && request.method === "POST") return handleHubSetup(request, env);
      if (url.pathname === "/api/v1/publish"   && request.method === "POST") return handlePublish(request, env);
      if (url.pathname === "/api/v1/delete"    && request.method === "POST") return handleDelete(request, env);
      if (url.pathname === "/api/v1/documents" && request.method === "GET")  return handleList(request, env);
      if (url.pathname === "/api/v1/health"    && request.method === "GET")  return jsonResponse({ status: "ok", version: "5.2.0" });

      return new Response("JotBird User Worker is Active", { status: 200 });

    } catch (err: any) {
      console.error("Worker Error:", err);
      return jsonResponse({ error: err.message || "Internal Server Error" }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────
// HUB SETUP (HANDSHAKE) logic
// ─────────────────────────────────────────────────────────

async function handleHubSetup(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const { hub_url, master_api_key, owner_id } = body;

  if (!hub_url || !master_api_key || !owner_id) {
    return jsonResponse({ error: "Missing required Hub configuration fields" }, 400);
  }

  const workerOrigin = new URL(request.url).origin;

  // ۱. ذخیره تنظیمات هاب در دیتابیس محلی کاربر
  await setSetting(env, "hub_url", hub_url.replace(/\/$/, ""));
  await setSetting(env, "master_api_key", master_api_key);
  await setSetting(env, "owner_id", owner_id);

  // ۲. انجام Handshake با هاب برای دریافت اولین توکن (Passport)
  try {
    const res = await fetch(`${hub_url}/api/v1/auth`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${master_api_key}`
      },
      body: JSON.stringify({ 
        worker_url: workerOrigin,
        owner_id: owner_id 
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      return jsonResponse({ error: `Hub rejected connection: ${errorText}` }, res.status);
    }

    const data: any = await res.json();
    if (data.token) {
      await setSetting(env, "master_jwt", data.token);
      return jsonResponse({ success: true, message: "Hub passport issued and stored" });
    }
    
    return jsonResponse({ error: "Hub did not return a valid token" }, 500);
  } catch (e: any) {
    return jsonResponse({ error: `Handshake failed: ${e.message}` }, 500);
  }
}

// ─────────────────────────────────────────────────────────
// PUBLISH HANDLER
// ─────────────────────────────────────────────────────────

async function handlePublish(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const url = new URL(request.url);

  const slug     = body.slug || crypto.randomUUID();
  const title    = body.title || "Untitled";
  const markdown = body.markdown || "";
  const isPublic = body.isPublic ? 1 : 0;
  const now      = Date.now();
  
  // ۱. تبدیل به HTML و ساخت صفحه
  const contentHtml = await marked.parse(markdown);
  const fullHtml    = buildHtmlPage(title, contentHtml, markdown);

  // ۲. ذخیره در D1
  await env.DB.prepare(`
    INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      html=excluded.html, markdown=excluded.markdown, title=excluded.title,
      tags=excluded.tags, folder=excluded.folder, is_public=excluded.is_public, updated_at=excluded.updated_at
  `).bind(
    slug, fullHtml, markdown, title, 
    JSON.stringify(body.tags || []), body.folder || "", 
    isPublic, now + (Number(body.expire_days || 30) * 86400000), now
  ).run();

  // ۳. سینک با هاب در صورت عمومی بودن
  if (isPublic) {
    const hubUrl  = await getSetting(env, "hub_url") || env.MASTER_WORKER_URL;
    const ownerId = await getSetting(env, "owner_id");
    
    if (hubUrl && ownerId) {
      // اجرای در پس‌زمینه بدون منتظر نگه داشتن کاربر
      await syncWithHub(env, hubUrl, ownerId, {
        slug, title, tags: body.tags || [], folder: body.folder || "", url: `${url.origin}/p/${slug}`, now
      });
    }
  }

  return jsonResponse({ success: true, slug, url: `${url.origin}/p/${slug}` });
}

// ─────────────────────────────────────────────────────────
// HUB SYNC LOGIC
// ─────────────────────────────────────────────────────────

async function syncWithHub(env: Env, hubUrl: string, ownerId: string, data: any) {
  let token = await getSetting(env, "master_jwt");
  const masterKey = await getSetting(env, "master_api_key") || env.MASTER_API_KEY;

  const push = async (jwt: string) => {
    return fetch(`${hubUrl}/api/v1/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jwt}` },
      body: JSON.stringify({
        slug: data.slug, owner_id: ownerId, title: data.title,
        tags: data.tags, folder: data.folder, url: data.url, updatedAt: data.now
      })
    });
  };

  let res = await push(token || "");

  // اگر توکن منقضی شده، یکی جدید بگیر و دوباره تلاش کن
  if (res.status === 401 && masterKey) {
    const authRes = await fetch(`${hubUrl}/api/v1/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${masterKey}` },
      body: JSON.stringify({ worker_url: new URL(data.url).origin, owner_id: ownerId })
    });

    if (authRes.ok) {
      const authData: any = await authRes.json();
      await setSetting(env, "master_jwt", authData.token);
      await push(authData.token);
    }
  }
}

// ─────────────────────────────────────────────────────────
// DATABASE HELPERS
// ─────────────────────────────────────────────────────────

async function getSetting(env: Env, key: string): Promise<string | null> {
  const res = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{value: string}>();
  return res ? res.value : null;
}

async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value).run();
}

// ─────────────────────────────────────────────────────────
// VIEW & LIST HANDLERS
// ─────────────────────────────────────────────────────────

async function handleView(request: Request, env: Env) {
  const id = new URL(request.url).pathname.replace("/p/", "");
  const post = await env.DB.prepare("SELECT html, is_public FROM posts WHERE id = ?").bind(id).first<{html: string, is_public: number}>();
  
  if (!post) return new Response("Note Not Found", { status: 404 });
  if (!post.is_public) return new Response("This note is private", { status: 403 });

  return new Response(post.html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const { slug } = await request.json() as any;
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(slug).run();
  
  // حذف از هاب
  const hubUrl = await getSetting(env, "hub_url");
  const ownerId = await getSetting(env, "owner_id");
  const token = await getSetting(env, "master_jwt");
  if (hubUrl && ownerId && token) {
    await fetch(`${hubUrl}/api/v1/index/${ownerId}/${slug}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` }
    });
  }
  return jsonResponse({ success: true });
}

async function handleList(request: Request, env: Env) {
  const { results } = await env.DB.prepare("SELECT id as slug, title, is_public, updated_at FROM posts ORDER BY updated_at DESC").all();
  return jsonResponse({ documents: results });
}

// ─────────────────────────────────────────────────────────
// HTML BUILDER & UI (RTL Support + Vazirmatn)
// ─────────────────────────────────────────────────────────

function buildHtmlPage(title: string, contentHtml: string, markdown: string) {
  const isRtl = /[\u0600-\u06FF]/.test(markdown + title);
  return `<!DOCTYPE html>
<html lang="${isRtl ? 'fa' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
  <style>
    :root { --bg: #0f172a; --text: #f1f5f9; --accent: #60a5fa; --card: #1e293b; }
    body { font-family: 'Vazirmatn', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.8; margin: 0; padding: 2rem 1rem; display: flex; justify-content: center; }
    .container { max-width: 800px; width: 100%; }
    h1 { color: var(--accent); font-size: 2.5rem; margin-bottom: 2rem; border-bottom: 2px solid var(--card); padding-bottom: 1rem; }
    .content { background: var(--card); padding: 2rem; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
    pre { background: #000; padding: 1rem; border-radius: 8px; overflow-x: auto; direction: ltr; text-align: left; }
    code { font-family: monospace; color: #fbbf24; }
    img { max-width: 100%; border-radius: 8px; }
    blockquote { border-${isRtl ? 'right' : 'left'}: 5px solid var(--accent); margin: 0; padding: 1rem; background: rgba(96,165,250,0.1); font-style: italic; }
    footer { margin-top: 4rem; text-align: center; color: #64748b; font-size: 0.8rem; border-top: 1px solid var(--card); padding-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <div class="content">${contentHtml}</div>
    <footer>Published with JotBird &copy; 2024</footer>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
