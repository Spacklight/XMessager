/**
 * XMessager backend — Cloudflare Worker
 *
 * Bindings expected:
 *   env.DB               - D1 database (binding "DB", see wrangler.toml)
 *   env.HF_TOKEN          - Hugging Face access token (write scope), secret
 *   env.ADMIN_TOKEN       - password for the admin endpoints/page, secret
 *
 * Per-video Hugging Face repo comes from the `datasets` table now, not a
 * fixed env var — that's what lets us route by continent and spread load
 * across multiple HF datasets.
 */

const MAX_INLINE_BYTES = 50 * 1024 * 1024; // 50MB per upload

const CONTINENT_ALIASES = {
  africa: "AF", af: "AF",
  asia: "AS", as: "AS",
  europe: "EU", eu: "EU",
  "north america": "NA", na: "NA",
  "south america": "SA", sa: "SA",
  oceania: "OC", oc: "OC",
  antarctica: "AN", an: "AN",
};

function normalizeContinent(input) {
  if (!input) return null;
  const key = input.toString().trim().toLowerCase();
  return CONTINENT_ALIASES[key] || input.toString().toUpperCase();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env, cors);
      }
      if (url.pathname === "/api/videos" && request.method === "GET") {
        return await handleFeed(request, env, cors);
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        return await handleSearch(request, env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500, cors);
    }
  },
};

async function handleUpload(request, env, cors) {
  if (!env.HF_TOKEN || !env.DB) {
    return json({ error: "Server misconfigured: HF_TOKEN / DB not set" }, 500, cors);
  }

  const form = await request.formData();
  const file = form.get("video");
  const title = (form.get("title") || "untitled").toString();
  const description = (form.get("description") || "").toString();
  const uploader = (form.get("uploader") || "anonymous").toString();

  // X-Messenger-Brain can force a continent (e.g. based on its own IP lookup).
  // Otherwise fall back to Cloudflare's built-in edge geolocation.
  const forcedContinent = form.get("continent");
  const continent = normalizeContinent(forcedContinent) || request.cf?.continent || "AF";

  if (!file || typeof file === "string") {
    return json({ error: "No video file provided (multipart field name: 'video')" }, 400, cors);
  }

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_INLINE_BYTES) {
    return json(
      { error: `File too large (${(buf.byteLength / 1e6).toFixed(1)}MB, limit ${MAX_INLINE_BYTES / 1e6}MB).` },
      413,
      cors
    );
  }
  const size = buf.byteLength;

  const dataset = await pickDataset(env.DB, continent, size);
  if (!dataset) {
    return json({ error: `No dataset with room available for continent ${continent}. Add one from the admin panel.` }, 503, cors);
  }

  const id = crypto.randomUUID();
  const nameParts = (file.name || "video.mp4").split(".");
  const ext = (nameParts.length > 1 ? nameParts.pop() : "mp4").toLowerCase();
  const path = `videos/${id}.${ext}`;

  let oid;
  try {
    ({ oid } = await uploadViaLfs(env, dataset.hf_repo, buf, path));
  } catch (err) {
    return json({ error: "Hugging Face LFS upload failed", details: err.message }, 502, cors);
  }

  const commitBody =
    JSON.stringify({
      key: "header",
      value: { summary: `Upload video ${id}`, description: `title=${title}; uploader=${uploader}` },
    }) +
    "\n" +
    JSON.stringify({ key: "lfsFile", value: { path, algo: "sha256", oid, size } });

  const hfRes = await fetch(`https://huggingface.co/api/datasets/${dataset.hf_repo}/commit/main`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "Content-Type": "application/x-ndjson" },
    body: commitBody,
  });

  if (!hfRes.ok) {
    return json({ error: "Hugging Face commit failed", details: await hfRes.text() }, hfRes.status, cors);
  }

  const videoUrl = `https://huggingface.co/datasets/${dataset.hf_repo}/resolve/main/${path}`;
  const uploadedAt = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO videos (id,title,description,continent,dataset_id,hf_repo,path,url,size_bytes,sha256,uploader,uploaded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, title, description, continent, dataset.id, dataset.hf_repo, path, videoUrl, size, oid, uploader, uploadedAt),
    env.DB.prepare(`UPDATE datasets SET used_bytes = used_bytes + ? WHERE id = ?`).bind(size, dataset.id),
  ]);

  return json({ id, title, description, continent, url: videoUrl, size, uploadedAt }, 200, cors);
}

// Picks the least-full active dataset for a continent that still has room.
// Falls back to the least-full active dataset overall if none match the continent.
async function pickDataset(db, continent, size) {
  let row = await db
    .prepare(
      `SELECT * FROM datasets WHERE continent = ? AND is_active = 1 AND used_bytes + ? <= capacity_bytes
       ORDER BY used_bytes ASC LIMIT 1`
    )
    .bind(continent, size)
    .first();

  if (!row) {
    row = await db
      .prepare(
        `SELECT * FROM datasets WHERE is_active = 1 AND used_bytes + ? <= capacity_bytes
         ORDER BY used_bytes ASC LIMIT 1`
      )
      .bind(size)
      .first();
  }
  return row || null;
}

async function handleFeed(request, env, cors) {
  const url = new URL(request.url);
  const continent = normalizeContinent(url.searchParams.get("continent"));
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);

  const query = continent
    ? db_query(env.DB, `SELECT id,title,description,url,continent,uploaded_at FROM videos WHERE continent = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`, [continent, limit, offset])
    : db_query(env.DB, `SELECT id,title,description,url,continent,uploaded_at FROM videos ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`, [limit, offset]);

  const { results } = await query;
  return json({ videos: results }, 200, cors);
}

async function handleSearch(request, env, cors) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ videos: [] }, 200, cors);

  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT id,title,description,url,continent,uploaded_at FROM videos
     WHERE title LIKE ? OR description LIKE ? ORDER BY uploaded_at DESC LIMIT 30`
  )
    .bind(like, like)
    .all();

  return json({ videos: results }, 200, cors);
}

function db_query(db, sql, params) {
  return db.prepare(sql).bind(...params).all();
}

async function uploadViaLfs(env, repo, buf, path) {
  const oid = await sha256Hex(buf);
  const size = buf.byteLength;

  const batchRes = await fetch(`https://huggingface.co/datasets/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.HF_TOKEN}`,
      Accept: "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json",
    },
    body: JSON.stringify({ operation: "upload", transfers: ["basic"], objects: [{ oid, size }], hash_algo: "sha256" }),
  });

  if (!batchRes.ok) throw new Error(`LFS batch request failed: ${await batchRes.text()}`);

  const batchJson = await batchRes.json();
  const obj = batchJson.objects && batchJson.objects[0];
  if (!obj) throw new Error("LFS batch response missing object info");
  if (obj.error) throw new Error(`LFS batch error: ${obj.error.message}`);

  if (obj.actions && obj.actions.upload) {
    const upload = obj.actions.upload;
    const putRes = await fetch(upload.href, { method: "PUT", headers: upload.header || {}, body: buf });
    if (!putRes.ok) throw new Error(`LFS object upload failed: ${putRes.status} ${await putRes.text()}`);
  }

  return { oid, size };
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
