import { marked } from "marked";

/**
 * JotBird User Worker - v5.5 (Service Binding Edition)
 * ───────────────────────────────────────────────────
 * قابلیت‌ها:
 * - حل خطای 1042 با استفاده از Service Binding (env.HUB)
 * - Handshake هوشمند با هاب (روت hub-setup)
 * - تبدیل Markdown به HTML مدرن و ریسپانسیو (Dark Mode)
 * - تشخیص هوشمند RTL و فونت وزیر برای متون فارسی
 * - همگام‌سازی خودکار با هاب جهانی (Hub Sync)
 */

export interface Env {
  DB: D1Database;
  HUB: Fetcher;              // Service Binding به ورکر هاب
  MASTER_WORKER_URL: string; // آدرس هاب (به عنوان پشتیبان)
  MASTER_API_KEY: string;    // کلید هاب (به عنوان پشتیبان)
  API_KEY: string;           // کلید امنیتی پلاگین
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method;
      
      // روتر هوشمند: حذف اسلش‌های تکراری و انتهایی
      const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");

      // روت عمومی مشاهده نوت
      if (path.startsWith("/p/")) {
        return handleView(path, env);
      }

      const authHeader = request.headers.get("Authorization") ?? "";

      // بررسی امنیت API_KEY پلاگین
      if (path.startsWith("/api/v1")) {
        if (authHeader !== `Bearer ${env.API_KEY}`) {
          return jsonResponse({ error: "Unauthorized: Invalid API Key" }, 401);
        }
      }

      // ─── Routing ───
      if (path === "/api/v1/hub-setup" && method === "POST") return handleHubSetup(request, env);
      if (path === "/api/v1/publish"   && method === "POST") return handlePublish(request, env);
      if (path === "/api/v1/delete"    && method === "POST") return handleDelete(request, env);
      if (path === "/api/v1/documents" && method === "GET")  return handleList(env);
      if (path === "/api/v1/health"    && method === "GET") {
        const hubToken = await getSetting(env, "master_jwt");
        return jsonResponse({ 
          status: "ok", 
          version: "5.5.0", 
          hub_connected: !!hubToken,
          using_binding: !!env.HUB 
        });
      }

      return jsonResponse({ error: "Route not found", path }, 404);

    } catch (err: any) {
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────
// ابزار مدیریت ارتباط با هاب (HUB CALLER)
// ─────────────────────────────────────────────────────────

/**
 * این تابع هوشمندانه تشخیص می‌دهد که از Service Binding استفاده کند یا Fetch معمولی
 * تا مشکل Error 1042 کلادفلر حل شود.
 */
async function callHub(env: Env, path: string, options: RequestInit, customHubUrl?: string) {
  if (env.HUB) {
    // استفاده از تونل داخلی (Service Binding) - آدرس دامنه در اینجا صوری است
    return env.HUB.fetch(`https://hub-internal${path}`, options);
  } else {
    // استفاده از اینترنت (Fetch معمولی)
    const targetBase = (customHubUrl || await getSetting(env, "hub_url") || env.MASTER_WORKER_URL || "").replace(/\/+$/, "");
    return fetch(`${targetBase}${path}`, options);
  }
}

// ─────────────────────────────────────────────────────────
// ۱. مدیریت اتصال به هاب (HUB SETUP)
// ─────────────────────────────────────────────────────────

async function handleHubSetup(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const { hub_url, master_api_key, owner_id } = body;

  if (!hub_url || !master_api_key || !owner_id) {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }

  const cleanHubUrl = hub_url.replace(/\/+$/, "");
  const workerOrigin = new URL(request.url).origin;

  // ذخیره تنظیمات در D1
  await setSetting(env, "hub_url", cleanHubUrl);
  await setSetting(env, "master_api_key", master_api_key);
  await setSetting(env, "owner_id", owner_id);

  try {
    // درخواست پاسپورت از هاب از طریق callHub (داخلی یا خارجی)
    const res = await callHub(env, "/api/v1/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${master_api_key}` },
      body: JSON.stringify({ worker_url: workerOrigin, owner_id })
    }, cleanHubUrl);

    if (!res.ok) {
      const errorMsg = await res.text();
      return jsonResponse({ error: `Hub rejected: ${errorMsg}` }, res.status);
    }

    const data: any = await res.json();
    if (data.token) {
      await setSetting(env, "master_jwt", data.token);
      return jsonResponse({ success: true, message: "Hub connected successfully via " + (env.HUB ? "Binding" : "Fetch") });
    }
    return jsonResponse({ error: "No token received" }, 500);
  } catch (e: any) {
    return jsonResponse({ error: `Hub connection failed: ${e.message}` }, 500);
  }
}

// ─────────────────────────────────────────────────────────
// ۲. انتشار نوت (PUBLISH)
// ─────────────────────────────────────────────────────────

async function handlePublish(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const url = new URL(request.url);

  const slug = body.slug || crypto.randomUUID();
  const title = body.title || "Untitled";
  const isPublic = body.isPublic ? 1 : 0;
  const now = Date.now();

  const contentHtml = await marked.parse(body.markdown || "");
  const fullHtml = buildHtmlPage(title, contentHtml, body.markdown || "");

  await env.DB.prepare(`
    INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      html=excluded.html, markdown=excluded.markdown, title=excluded.title,
      tags=excluded.tags, folder=excluded.folder, is_public=excluded.is_public, updated_at=excluded.updated_at
  `).bind(
    slug, fullHtml, body.markdown || "", title, 
    JSON.stringify(body.tags || []), body.folder || "", 
    isPublic, now + (Number(body.expire_days || 30) * 86400000), now
  ).run();

  if (isPublic) {
    const ownerId = await getSetting(env, "owner_id");
    const token = await getSetting(env, "master_jwt");

    if (ownerId && token) {
      // ارسال به هاب در پس‌زمینه (استفاده از callHub)
      callHub(env, "/api/v1/index", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          slug, owner_id: ownerId, title, tags: body.tags || [], 
          folder: body.folder || "", url: `${url.origin}/p/${slug}`, updatedAt: now
        })
      });
    }
  }

  return jsonResponse({ success: true, slug, url: `${url.origin}/p/${slug}` });
}

// ─────────────────────────────────────────────────────────
// ۳. حذف نوت (DELETE)
// ─────────────────────────────────────────────────────────

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const { slug } = await request.json() as any;
  if (!slug) return jsonResponse({ error: "Slug required" }, 400);

  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(slug).run();

  const ownerId = await getSetting(env, "owner_id");
  const token = await getSetting(env, "master_jwt");

  if (ownerId && token) {
    // حذف از هاب از طریق callHub
    callHub(env, `/api/v1/index/${ownerId}/${slug}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` }
    });
  }

  return jsonResponse({ success: true, message: "Deleted locally and sync request sent to Hub" });
}

// ─────────────────────────────────────────────────────────
// مشاهده و لیست (VIEW & LIST)
// ─────────────────────────────────────────────────────────

async function handleView(path: string, env: Env): Promise<Response> {
  const id = path.replace("/p/", "");
  const post = await env.DB.prepare("SELECT html, is_public, expire_at FROM posts WHERE id = ?").bind(id).first<{html: string, is_public: number, expire_at: number}>();
  
  if (!post || !post.is_public || Date.now() > post.expire_at) {
    return new Response("Not Found or Private", { status: 404 });
  }

  return new Response(post.html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT id as slug, title, is_public, updated_at FROM posts ORDER BY updated_at DESC").all();
  return jsonResponse({ documents: results });
}

// ─────────────────────────────────────────────────────────
// توابع کمکی (HELPERS)
// ─────────────────────────────────────────────────────────

async function getSetting(env: Env, key: string) {
  const res = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{value: string}>();
  return res ? res.value : null;
}

async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json", 
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE"
    }
  });
}

function buildHtmlPage(title: string, contentHtml: string, markdown: string) {
  const isRtl = /[\u0600-\u06FF]/.test(markdown + title);
  return `<!DOCTYPE html>
<html lang="${isRtl ? 'fa' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
  <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
  <style>
    :root { --bg: #0f172a; --text: #f1f5f9; --accent: #60a5fa; --card: #1e293b; --border: #334155; }
    body { font-family: 'Vazirmatn', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.8; margin: 0; padding: 2rem 1rem; display: flex; justify-content: center; }
    .container { max-width: 800px; width: 100%; }
    .content { background: var(--card); padding: 2.5rem; border-radius: 12px; border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
    h1 { color: var(--accent); margin-bottom: 1.5rem; }
    pre { background: #000; padding: 1rem; border-radius: 8px; overflow-x: auto; direction: ltr; text-align: left; }
    code { color: #fbbf24; font-family: monospace; }
    blockquote { border-${isRtl?'right':'left'}: 5px solid var(--accent); padding: 0.5rem 1.5rem; background: rgba(96,165,250,0.1); font-style: italic; margin: 1.5rem 0; }
    img { max-width: 100%; border-radius: 8px; }
    footer { margin-top: 4rem; text-align: center; color: #64748b; font-size: 0.8rem; border-top: 1px solid var(--card); padding-top: 2rem; }
    a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <header><h1>${title}</h1></header>
    <main class="content">${contentHtml}</main>
    <footer>Published with <a href="https://jotbird.app">JotBird</a></footer>
  </div>
</body>
</html>`;
}
