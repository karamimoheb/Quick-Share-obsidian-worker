export interface Env {
  DB: D1Database;
  MASTER_WORKER_URL: string;
  MASTER_API_KEY: string;
  API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await ensureTables(env);

      const url = new URL(request.url);
      const authHeader = request.headers.get("Authorization");

      if (["POST", "DELETE", "PUT"].includes(request.method)) {
        if (authHeader !== `Bearer ${env.API_KEY}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      }

      if (url.pathname.startsWith("/p/")) return handleView(request, env);
      if (url.pathname === "/api/v1/publish") return handlePublish(request, env);
      if (url.pathname === "/api/v1/documents") return handleList(request, env);
      
      return new Response("JotBird User Worker Running", { status: 200 });
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }
};

async function ensureTables(env: Env) {
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, html TEXT NOT NULL, markdown TEXT, title TEXT,
      tags TEXT, folder TEXT, is_public INTEGER DEFAULT 0,
      expire_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `);
}

async function handlePublish(request: Request, env: Env) {
  const body: any = await request.json();
  const url = new URL(request.url);
  
  const slug = body.slug || crypto.randomUUID();
  const title = body.title || "Untitled";
  const now = Date.now();
  const isPublic = body.isPublic ? 1 : 0;
  const ownerId = body.owner_id || "anonymous";

  await env.DB.prepare(`
    INSERT INTO posts (id, html, markdown, title, tags, folder, is_public, expire_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
    html=excluded.html, markdown=excluded.markdown, title=excluded.title,
    tags=excluded.tags, folder=excluded.folder, is_public=excluded.is_public, updated_at=excluded.updated_at
  `).bind(
    slug, body.html || "", body.markdown, title, 
    JSON.stringify(body.tags || []), body.folder || "", 
    isPublic, now + (30 * 86400000), now
  ).run();

  if (isPublic && env.MASTER_WORKER_URL) {
    let token = await getSessionToken(env);
    
    // Handshake: If no token, request a new one
    if (!token) {
      token = await requestNewToken(env, url.origin, ownerId);
    }

    if (token) {
      let syncResponse = await pushToMaster(env, token, body, slug, url.origin, now);
      
      // Rotation: If token expired or rejected, retry once with a new token
      if (syncResponse.status === 401) {
        token = await requestNewToken(env, url.origin, ownerId);
        if (token) await pushToMaster(env, token, body, slug, url.origin, now);
      }
    }
  }

  return Response.json({ success: true, slug, url: `${url.origin}/p/${slug}` });
}

async function getSessionToken(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'master_jwt'").first<any>();
  return row ? row.value : null;
}

async function requestNewToken(env: Env, origin: string, ownerId: string): Promise<string | null> {
  try {
    const res = await fetch(`${env.MASTER_WORKER_URL}/api/v1/auth`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.MASTER_API_KEY}`
      },
      body: JSON.stringify({ worker_url: origin, owner_id: ownerId })
    });
    
    if (res.ok) {
      const data: any = await res.json();
      await env.DB.prepare(`
        INSERT INTO settings (key, value) VALUES ('master_jwt', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).bind(data.token).run();
      return data.token;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function pushToMaster(env: Env, token: string, body: any, slug: string, origin: string, now: number) {
  return fetch(`${env.MASTER_WORKER_URL}/api/v1/index`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "Authorization": `Bearer ${token}` 
    },
    body: JSON.stringify({
      slug, title: body.title || "Untitled", tags: body.tags || [],
      owner_id: body.owner_id || "anonymous",
      url: `${origin}/p/${slug}`,
      updatedAt: now
    })
  });
}

async function handleView(request: Request, env: Env) {
  const id = new URL(request.url).pathname.replace("/p/", "");
  const post = await env.DB.prepare("SELECT html FROM posts WHERE id = ?").bind(id).first<any>();
  if (!post) return new Response("Not Found", { status: 404 });
  return new Response(post.html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleList(request: Request, env: Env) {
  const { results } = await env.DB.prepare("SELECT id as slug, title, is_public, updated_at FROM posts ORDER BY updated_at DESC").all();
  return Response.json({ documents: results });
}
