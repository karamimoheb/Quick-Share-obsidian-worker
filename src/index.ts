import { marked } from "marked";

/**
 * JotBird User Worker - v5.4 (Full Production Version)
 * ───────────────────────────────────────────────────
 * قابلیت‌ها:
 * - مدیریت کامل Handshake با هاب (روت hub-setup)
 * - تبدیل Markdown به HTML مدرن و ریسپانسیو
 * - تشخیص هوشمند RTL و فونت وزیر برای متون فارسی
 * - همگام‌سازی خودکار با هاب جهانی (Hub Sync)
 * - روتر هوشمند برای جلوگیری از خطای 404 اسلش
 */

export interface Env {
  DB: D1Database;
  MASTER_WORKER_URL: string; // آدرس هاب پیش‌فرض
  MASTER_API_KEY: string;    // کلید هاب پیش‌فرض
  API_KEY: string;           // کلید امنیتی پلاگین
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method;
      
      // روتر هوشمند: حذف اسلش‌های تکراری و انتهایی برای جلوگیری از 404
      const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");

      // روت عمومی مشاهده نوت (استثنا برای مسیر /p/)
      if (path.startsWith("/p/")) {
        return handleView(path, env);
      }

      const authHeader = request.headers.get("Authorization") ?? "";

      // بررسی امنیت برای تمام مسیرهای API (Bearer Token)
      if (path.startsWith("/api/v1")) {
        if (authHeader !== `Bearer ${env.API_KEY}`) {
          return jsonResponse({ error: "Unauthorized: Invalid API Key" }, 401);
        }
      }

      // ─── مدیریت مسیرها (Routing) ───
      
      // ۱. تنظیمات اولیه هاب از سمت پلاگین
      if (path === "/api/v1/hub-setup" && method === "POST") {
        return handleHubSetup(request, env);
      }

      // ۲. انتشار یا بروزرسانی نوت
      if (path === "/api/v1/publish" && method === "POST") {
        return handlePublish(request, env);
      }

      // ۳. حذف نوت
      if (path === "/api/v1/delete" && method === "POST") {
        return handleDelete(request, env);
      }

      // ۴. لیست نوت‌ها
      if (path === "/api/v1/documents" && method === "GET") {
        return handleList(env);
      }

      // ۵. چک کردن وضعیت سلامت و اتصال به هاب
      if (path === "/api/v1/health" && method === "GET") {
        const hubToken = await getSetting(env, "master_jwt");
        return jsonResponse({ 
          status: "ok", 
          version: "5.4.0", 
          hub_connected: !!hubToken 
        });
      }

      return jsonResponse({ error: "Route not found", path }, 404);

    } catch (err: any) {
      console.error("Worker Global Error:", err.message);
      return jsonResponse({ error: err.message }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────
// ۱. مدیریت اتصال به هاب (HUB SETUP)
// ─────────────────────────────────────────────────────────

async function handleHubSetup(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const { hub_url, master_api_key, owner_id } = body;

  if (!hub_url || !master_api_key || !owner_id) {
    return jsonResponse({ error: "Missing config fields: hub_url, master_api_key, or owner_id" }, 400);
  }

  const cleanHubUrl = hub_url.replace(/\/+$/, "");
  const workerOrigin = new URL(request.url).origin;

  // ذخیره تنظیمات در دیتابیس محلی کاربر
  await setSetting(env, "hub_url", cleanHubUrl);
  await setSetting(env, "master_api_key", master_api_key);
  await setSetting(env, "owner_id", owner_id);

  // انجام Handshake با هاب برای دریافت توکن پاسپورت
  try {
    const res = await fetch(`${cleanHubUrl}/api/v1/auth`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${master_api_key}`
      },
      body: JSON.stringify({ worker_url: workerOrigin, owner_id })
    });

    if (!res.ok) {
      const errorMsg = await res.text();
      return jsonResponse({ error: `Hub rejected connection: ${errorMsg}` }, res.status);
    }

    const data: any = await res.json();
    if (data.token) {
      await setSetting(env, "master_jwt", data.token);
      return jsonResponse({ success: true, message: "Connected to Hub. Passport stored." });
    }
    
    return jsonResponse({ error: "Hub failed to provide a token" }, 500);
  } catch (e: any) {
    return jsonResponse({ error: `Hub connection error: ${e.message}` }, 500);
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
  const markdown = body.markdown || "";
  const isPublic = body.isPublic ? 1 : 0;
  const now = Date.now();

  // تبدیل مارک‌دان به HTML
  const contentHtml = await marked.parse(markdown);
  
  // ساخت صفحه کامل HTML با استایل‌های مدرن
  const fullHtml = buildHtmlPage(title, contentHtml, markdown);

  // ذخیره در دیتابیس D1
  await env.DB.prepare(`
    INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      html=excluded.html, markdown=excluded.markdown, title=excluded.title,
      tags=excluded.tags, folder=excluded.folder, is_public=excluded.is_public, 
      updated_at=excluded.updated_at
  `).bind(
    slug, fullHtml, markdown, title, 
    JSON.stringify(body.tags || []), body.folder || "", 
    isPublic, now + (Number(body.expire_days || 30) * 86400000), now
  ).run();

  // همگام‌سازی با هاب در صورت عمومی بودن
  if (isPublic) {
    const hubUrl = await getSetting(env, "hub_url") || env.MASTER_WORKER_URL;
    const ownerId = await getSetting(env, "owner_id");
    const token = await getSetting(env, "master_jwt");

    if (hubUrl && ownerId && token) {
      // ارسال در پس‌زمینه
      fetch(`${hubUrl}/api/v1/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({
          slug, owner_id: ownerId, title, 
          tags: body.tags || [], folder: body.folder || "", 
          url: `${url.origin}/p/${slug}`, updatedAt: now
        })
      });
    }
  }

  return jsonResponse({ success: true, slug, url: `${url.origin}/p/${slug}` });
}

// ─────────────────────────────────────────────────────────
// ۳. مشاهده نوت (VIEW)
// ─────────────────────────────────────────────────────────

async function handleView(path: string, env: Env): Promise<Response> {
  const id = path.replace("/p/", "");
  const post = await env.DB.prepare("SELECT html, is_public, expire_at FROM posts WHERE id = ?")
    .bind(id)
    .first<{html: string, is_public: number, expire_at: number}>();
  
  if (!post) return new Response("Note Not Found", { status: 404 });
  
  // بررسی خصوصی بودن یا انقضا
  if (!post.is_public || Date.now() > post.expire_at) {
    return new Response("This note is private or has expired.", { status: 403 });
  }

  return new Response(post.html, { 
    headers: { "Content-Type": "text/html;charset=UTF-8" } 
  });
}

// ─────────────────────────────────────────────────────────
// ۴. حذف نوت (DELETE)
// ─────────────────────────────────────────────────────────

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const { slug } = await request.json() as any;
  if (!slug) return jsonResponse({ error: "Slug required" }, 400);

  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(slug).run();

  // حذف از هاب جهانی
  const hubUrl = await getSetting(env, "hub_url");
  const ownerId = await getSetting(env, "owner_id");
  const token = await getSetting(env, "master_jwt");

  if (hubUrl && ownerId && token) {
    fetch(`${hubUrl}/api/v1/index/${ownerId}/${slug}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` }
    });
  }

  return jsonResponse({ success: true, message: "Deleted locally and from Hub" });
}

// ─────────────────────────────────────────────────────────
// ۵. لیست نوت‌ها (LIST)
// ─────────────────────────────────────────────────────────

async function handleList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id as slug, title, is_public, updated_at, folder FROM posts ORDER BY updated_at DESC"
  ).all();
  return jsonResponse({ documents: results });
}

// ─────────────────────────────────────────────────────────
// توابع کمکی دیتابیس (SETTINGS HELPERS)
// ─────────────────────────────────────────────────────────

async function getSetting(env: Env, key: string): Promise<string | null> {
  const res = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{value: string}>();
  return res ? res.value : null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, value).run();
}

// ─────────────────────────────────────────────────────────
// رابط کاربری (HTML BUILDER - RTL & Vazirmatn)
// ─────────────────────────────────────────────────────────

function buildHtmlPage(title: string, contentHtml: string, markdown: string) {
  const isRtl = /[\u0600-\u06FF]/.test(markdown + title);
  
  return `<!DOCTYPE html>
<html lang="${isRtl ? 'fa' : 'en'}" dir="${isRtl ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
  <style>
    :root {
      --bg: #0f172a; --text: #f1f5f9; --accent: #60a5fa; --card: #1e293b; --border: #334155;
    }
    body {
      font-family: 'Vazirmatn', system-ui, -apple-system, sans-serif;
      background-color: var(--bg); color: var(--text);
      line-height: 1.8; margin: 0; padding: 2rem 1rem;
      display: flex; justify-content: center;
    }
    .container { max-width: 800px; width: 100%; }
    header { border-bottom: 2px solid var(--card); padding-bottom: 1.5rem; margin-bottom: 2rem; }
    h1 { font-size: 2.2rem; color: var(--accent); margin: 0; }
    .content { 
      background: var(--card); padding: 2rem; border-radius: 12px; 
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3); border: 1px solid var(--border);
    }
    .content img { max-width: 100%; border-radius: 8px; }
    pre { 
      background: #000; padding: 1rem; border-radius: 8px; overflow-x: auto; 
      direction: ltr; text-align: left; border: 1px solid var(--border);
    }
    code { font-family: 'Fira Code', monospace; color: #fbbf24; font-size: 0.9em; }
    blockquote { 
      border-${isRtl ? 'right' : 'left'}: 5px solid var(--accent); 
      margin: 1.5rem 0; padding: 0.5rem 1.5rem; background: rgba(96,165,250,0.1); 
      font-style: italic; color: #cbd5e1;
    }
    footer { 
      margin-top: 4rem; text-align: center; color: #64748b; 
      font-size: 0.85rem; border-top: 1px solid var(--card); padding-top: 2rem; 
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
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

// ─────────────────────────────────────────────────────────
// ابزارهای کمکی (UTILITIES)
// ─────────────────────────────────────────────────────────

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      "Content-Type": "application/json", 
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}
