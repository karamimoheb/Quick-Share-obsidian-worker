import { marked } from "marked";

export interface Env {
  DB: D1Database;
  MASTER_WORKER_URL: string;
  MASTER_API_KEY: string;
  API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const authHeader = request.headers.get("Authorization");

      // مسیر عمومی مشاهده نوت
      if (url.pathname.startsWith("/p/")) return handleView(request, env);

      // امنیت مسیرهای حساس
      if (["POST", "DELETE", "PUT"].includes(request.method)) {
        if (authHeader !== `Bearer ${env.API_KEY}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      }

      if (url.pathname === "/api/v1/publish" && request.method === "POST") return handlePublish(request, env);
      if (url.pathname === "/api/v1/documents" && request.method === "GET") return handleList(request, env);
      if (url.pathname === "/api/v1/health") return Response.json({ status: "ok" });
      
      return new Response("JotBird Worker Ready", { status: 200 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
};

// ─── تابع کمکی برای تشخیص فارسی/عربی (RTL) ───
function isRtl(text: string): boolean {
  const rtlChars = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return rtlChars.test(text);
}

// ─── قالب HTML مدرن و ریسپانسیو ───
function buildHtmlPage(title: string, contentHtml: string, markdown: string) {
  const isRightToLeft = isRtl(markdown + title);
  const direction = isRightToLeft ? "rtl" : "ltr";
  const fontFamily = isRightToLeft ? "'Vazirmatn', sans-serif" : "system-ui, -apple-system, sans-serif";

  return `<!DOCTYPE html>
<html lang="${isRightToLeft ? 'fa' : 'en'}" dir="${direction}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet" type="text/css" />
  <style>
    :root {
      --bg: #ffffff;
      --text: #1a1a1a;
      --accent: #2563eb;
      --faint: #f3f4f6;
      --border: #e5e7eb;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --text: #f1f5f9;
        --accent: #60a5fa;
        --faint: #1e293b;
        --border: #334155;
      }
    }
    body {
      font-family: ${fontFamily};
      line-height: 1.8;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem 1rem;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 750px;
      width: 100%;
    }
    h1 { font-size: 2.2rem; margin-bottom: 1.5rem; line-height: 1.2; color: var(--accent); }
    .content { font-size: 1.1rem; }
    .content img { max-width: 100%; border-radius: 8px; }
    .content pre { 
      background: var(--faint); 
      padding: 1rem; 
      border-radius: 8px; 
      overflow-x: auto; 
      direction: ltr; /* کدها همیشه چپ‌چین */
      text-align: left;
    }
    .content code { font-family: monospace; background: var(--faint); padding: 0.2rem 0.4rem; border-radius: 4px; }
    .content blockquote { 
      border-${isRightToLeft ? 'right' : 'left'}: 4px solid var(--accent); 
      margin: 0; 
      padding: 0.5rem 1.5rem; 
      background: var(--faint);
      font-style: italic;
    }
    hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
    footer { margin-top: 3rem; font-size: 0.9rem; color: gray; text-align: center; border-top: 1px solid var(--border); padding-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${title}</h1>
    </header>
    <div class="content">
      ${contentHtml}
    </div>
    <footer>
      Published via JotBird
    </footer>
  </div>
</body>
</html>`;
}

async function handlePublish(request: Request, env: Env) {
  let body: any;
  try { body = await request.json(); } catch (e) { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const url = new URL(request.url);
  const slug = body.slug || crypto.randomUUID();
  const title = body.title || "Untitled";
  const markdown = body.markdown || "";
  
  // ─── تبدیل مارک‌دان به HTML ───
  const contentHtml = marked.parse(markdown);
  
  // ─── ساخت صفحه کامل HTML با استایل ───
  const fullPageHtml = buildHtmlPage(title, contentHtml as string, markdown);

  const now = Date.now();
  const isPublic = body.isPublic ? 1 : 0;

  await env.DB.prepare(`
    INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
    html=excluded.html, markdown=excluded.markdown, title=excluded.title,
    is_public=excluded.is_public, updated_at=excluded.updated_at
  `).bind(
    slug, fullPageHtml, markdown, title, 
    JSON.stringify(body.tags || []), body.folder || "", 
    isPublic, now + (30 * 86400000), now
  ).run();

  // منطق Sync با Master (بدون تغییر)
  if (isPublic && env.MASTER_WORKER_URL) {
    // ... بقیه منطق pushToMaster شما ...
  }

  return Response.json({ success: true, slug, url: `${url.origin}/p/${slug}` });
}

async function handleView(request: Request, env: Env) {
  const id = new URL(request.url).pathname.replace("/p/", "");
  const post = await env.DB.prepare("SELECT html FROM posts WHERE id = ?").bind(id).first<{html: string}>();
  if (!post) return new Response("Note Not Found", { status: 404 });
  
  return new Response(post.html, { 
    headers: { "Content-Type": "text/html;charset=UTF-8" } 
  });
}

async function handleList(request: Request, env: Env) {
  const { results } = await env.DB.prepare("SELECT id as slug, title, is_public, updated_at FROM posts ORDER BY updated_at DESC").all();
  return Response.json({ documents: results });
}
