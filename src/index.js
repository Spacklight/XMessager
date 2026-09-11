/**
 * XMessager backend — Cloudflare Worker
 *
 * Bindings expected:
 *   env.DB          - D1 database (binding "DB")
 *   env.HF_TOKEN     - Hugging Face access token (write scope), secret
 *   env.ADMIN_TOKEN  - password for /admin and /api/admin/*, secret
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

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/api/upload" && request.method === "POST") return await handleUpload(request, env, cors);
      if (url.pathname === "/api/videos" && request.method === "GET") return await handleFeed(request, env, cors);
      if (url.pathname === "/api/search" && request.method === "GET") return await handleSearch(request, env, cors);

      if (url.pathname === "/admin" && request.method === "GET") return adminPage(cors);
      if (url.pathname === "/api/admin/stats" && request.method === "GET") return await withAdmin(request, env, cors, adminStats);
      if (url.pathname === "/api/admin/datasets" && request.method === "GET") return await withAdmin(request, env, cors, listDatasets);
      if (url.pathname === "/api/admin/datasets" && request.method === "POST") return await withAdmin(request, env, cors, addDataset, request);

      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500, cors);
    }
  },
};

// ---------- upload / feed / search (unchanged from before) ----------

async function handleUpload(request, env, cors) {
  if (!env.HF_TOKEN || !env.DB) return json({ error: "Server misconfigured: HF_TOKEN / DB not set" }, 500, cors);

  const form = await request.formData();
  const file = form.get("video");
  const title = (form.get("title") || "untitled").toString();
  const description = (form.get("description") || "").toString();
  const uploader = (form.get("uploader") || "anonymous").toString();
  const forcedContinent = form.get("continent");
  const continent = normalizeContinent(forcedContinent) || request.cf?.continent || "AF";

  if (!file || typeof file === "string") return json({ error: "No video file provided (multipart field name: 'video')" }, 400, cors);

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_INLINE_BYTES) {
    return json({ error: `File too large (${(buf.byteLength / 1e6).toFixed(1)}MB, limit ${MAX_INLINE_BYTES / 1e6}MB).` }, 413, cors);
  }
  const size = buf.byteLength;

  const dataset = await pickDataset(env.DB, continent, size);
  if (!dataset) return json({ error: `No dataset with room available for continent ${continent}. Add one from /admin.` }, 503, cors);

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
    JSON.stringify({ key: "header", value: { summary: `Upload video ${id}`, description: `title=${title}; uploader=${uploader}` } }) +
    "\n" +
    JSON.stringify({ key: "lfsFile", value: { path, algo: "sha256", oid, size } });

  const hfRes = await fetch(`https://huggingface.co/api/datasets/${dataset.hf_repo}/commit/main`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, "Content-Type": "application/x-ndjson" },
    body: commitBody,
  });
  if (!hfRes.ok) return json({ error: "Hugging Face commit failed", details: await hfRes.text() }, hfRes.status, cors);

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

async function pickDataset(db, continent, size) {
  let row = await db
    .prepare(`SELECT * FROM datasets WHERE continent = ? AND is_active = 1 AND used_bytes + ? <= capacity_bytes ORDER BY used_bytes ASC LIMIT 1`)
    .bind(continent, size)
    .first();
  if (!row) {
    row = await db
      .prepare(`SELECT * FROM datasets WHERE is_active = 1 AND used_bytes + ? <= capacity_bytes ORDER BY used_bytes ASC LIMIT 1`)
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

  const stmt = continent
    ? env.DB.prepare(`SELECT id,title,description,url,continent,uploaded_at FROM videos WHERE continent = ? ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`).bind(continent, limit, offset)
    : env.DB.prepare(`SELECT id,title,description,url,continent,uploaded_at FROM videos ORDER BY uploaded_at DESC LIMIT ? OFFSET ?`).bind(limit, offset);

  const { results } = await stmt.all();
  return json({ videos: results }, 200, cors);
}

async function handleSearch(request, env, cors) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ videos: [] }, 200, cors);
  const like = `%${q}%`;
  const { results } = await env.DB.prepare(
    `SELECT id,title,description,url,continent,uploaded_at FROM videos WHERE title LIKE ? OR description LIKE ? ORDER BY uploaded_at DESC LIMIT 30`
  ).bind(like, like).all();
  return json({ videos: results }, 200, cors);
}

async function uploadViaLfs(env, repo, buf, path) {
  const oid = await sha256Hex(buf);
  const size = buf.byteLength;
  const batchRes = await fetch(`https://huggingface.co/datasets/${repo}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.HF_TOKEN}`, Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" },
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

// ---------- admin ----------

async function withAdmin(request, env, cors, handler, extra) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401, cors);
  }
  return handler(env, cors, extra);
}

async function listDatasets(env, cors) {
  const { results } = await env.DB.prepare(`SELECT * FROM datasets ORDER BY continent, used_bytes ASC`).all();
  return json({ datasets: results }, 200, cors);
}

async function addDataset(env, cors, request) {
  const body = await request.json();
  const continent = normalizeContinent(body.continent);
  const hfRepo = (body.hf_repo || "").trim();
  const capacityBytes = parseInt(body.capacity_bytes || 96636764160, 10); // default ~90GB, headroom under the 100GB free tier

  if (!continent || !hfRepo) return json({ error: "continent and hf_repo are required" }, 400, cors);

  try {
    await env.DB.prepare(
      `INSERT INTO datasets (continent, hf_repo, capacity_bytes, used_bytes, is_active, created_at) VALUES (?,?,?,0,1,?)`
    ).bind(continent, hfRepo, capacityBytes, Date.now()).run();
  } catch (err) {
    return json({ error: `Could not add dataset (is hf_repo already registered?): ${err.message}` }, 400, cors);
  }

  return json({ ok: true, continent, hf_repo: hfRepo, capacity_bytes: capacityBytes }, 200, cors);
}

async function adminStats(env, cors) {
  const totals = await env.DB.prepare(`SELECT COUNT(*) as videoCount, COALESCE(SUM(size_bytes),0) as totalBytes FROM videos`).first();
  const { results: perContinent } = await env.DB.prepare(
    `SELECT continent, COUNT(*) as videoCount, COALESCE(SUM(size_bytes),0) as totalBytes FROM videos GROUP BY continent`
  ).all();
  const { results: datasets } = await env.DB.prepare(`SELECT * FROM datasets ORDER BY continent`).all();
  const { results: duplicates } = await env.DB.prepare(
    `SELECT sha256, COUNT(*) as copies, GROUP_CONCAT(title, ' | ') as titles FROM videos GROUP BY sha256 HAVING COUNT(*) > 1`
  ).all();
  const { results: recent } = await env.DB.prepare(
    `SELECT id, title, continent, hf_repo, size_bytes, uploaded_at FROM videos ORDER BY uploaded_at DESC LIMIT 20`
  ).all();

  return json({ totals, perContinent, datasets, duplicates, recent }, 200, cors);
}

function adminPage(cors) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>XMessager Admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:16px}
h1{font-size:1.2rem} h2{font-size:1rem;margin-top:2rem;color:#9fd3ff}
input,select,button{padding:8px;margin:4px 0;border-radius:6px;border:1px solid #333;background:#1b1e26;color:#eee;width:100%;box-sizing:border-box}
button{background:#3468e0;border:none;cursor:pointer;font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:.85rem}
td,th{border-bottom:1px solid #2a2d36;padding:6px;text-align:left}
.bar{height:8px;background:#2a2d36;border-radius:4px;overflow:hidden}
.bar>div{height:100%;background:#3468e0}
.hidden{display:none}
</style></head>
<body>
<div id="login">
<h1>XMessager Admin</h1>
<input id="tok" type="password" placeholder="Admin token">
<button onclick="doLogin()">Enter</button>
</div>
<div id="dash" class="hidden">
<h1>XMessager Admin Dashboard</h1>

<h2>Add a dataset</h2>
<select id="continent">
<option value="AF">Africa</option><option value="AS">Asia</option><option value="EU">Europe</option>
<option value="NA">North America</option><option value="SA">South America</option>
<option value="OC">Oceania</option><option value="AN">Antarctica</option>
</select>
<input id="repo" placeholder="username/dataset-name (Hugging Face)">
<button onclick="addDataset()">Add dataset</button>
<p id="addMsg"></p>

<h2>Datasets & usage</h2>
<table id="dsTable"><thead><tr><th>Continent</th><th>Repo</th><th>Used</th><th></th></tr></thead><tbody></tbody></table>

<h2>Overview</h2>
<div id="overview"></div>

<h2>Duplicate videos (same content, different upload)</h2>
<table id="dupTable"><thead><tr><th>Copies</th><th>Titles</th></tr></thead><tbody></tbody></table>

<h2>Recent uploads (data flow)</h2>
<table id="recentTable"><thead><tr><th>Title</th><th>Continent</th><th>Repo</th><th>Size</th><th>When</th></tr></thead><tbody></tbody></table>
</div>

<script>
let TOKEN = localStorage.getItem('xm_admin_token') || '';
function fmtBytes(n){ if(!n) return '0 MB'; return (n/1e6).toFixed(1)+' MB'; }
function fmtDate(ts){ return new Date(ts).toLocaleString(); }

async function api(path, opts={}) {
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers||{}), Authorization: 'Bearer '+TOKEN } });
  if (res.status === 401) { localStorage.removeItem('xm_admin_token'); document.getElementById('login').classList.remove('hidden'); document.getElementById('dash').classList.add('hidden'); throw new Error('Unauthorized'); }
  return res.json();
}

async function doLogin(){
  TOKEN = document.getElementById('tok').value;
  try {
    await api('/api/admin/stats');
    localStorage.setItem('xm_admin_token', TOKEN);
    document.getElementById('login').classList.add('hidden');
    document.getElementById('dash').classList.remove('hidden');
    loadAll();
  } catch(e) { alert('Wrong token'); }
}

async function addDataset(){
  const continent = document.getElementById('continent').value;
  const hf_repo = document.getElementById('repo').value.trim();
  if(!hf_repo){ document.getElementById('addMsg').textContent='Enter a repo name.'; return; }
  const r = await api('/api/admin/datasets', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ continent, hf_repo }) });
  document.getElementById('addMsg').textContent = r.error ? ('Error: '+r.error) : ('Added '+r.hf_repo+' for '+r.continent);
  loadAll();
}

async function loadAll(){
  const stats = await api('/api/admin/stats');

  const dsBody = document.querySelector('#dsTable tbody'); dsBody.innerHTML='';
  stats.datasets.forEach(d=>{
    const pct = Math.min(100, Math.round((d.used_bytes/d.capacity_bytes)*100));
    dsBody.innerHTML += \`<tr><td>\${d.continent}</td><td>\${d.hf_repo}</td>
      <td>\${fmtBytes(d.used_bytes)} / \${fmtBytes(d.capacity_bytes)}<div class="bar"><div style="width:\${pct}%"></div></div></td>
      <td>\${d.is_active? 'active':'inactive'}</td></tr>\`;
  });

  const totalMB = fmtBytes(stats.totals.totalBytes);
  let overviewHtml = \`<p>\${stats.totals.videoCount} videos total, \${totalMB} stored.</p><ul>\`;
  stats.perContinent.forEach(c=>{ overviewHtml += \`<li>\${c.continent}: \${c.videoCount} videos, \${fmtBytes(c.totalBytes)}</li>\`; });
  overviewHtml += '</ul>';
  document.getElementById('overview').innerHTML = overviewHtml;

  const dupBody = document.querySelector('#dupTable tbody'); dupBody.innerHTML = stats.duplicates.length
    ? stats.duplicates.map(d=>\`<tr><td>\${d.copies}</td><td>\${d.titles}</td></tr>\`).join('')
    : '<tr><td colspan="2">No duplicates found.</td></tr>';

  const recBody = document.querySelector('#recentTable tbody');
  recBody.innerHTML = stats.recent.map(v=>\`<tr><td>\${v.title}</td><td>\${v.continent}</td><td>\${v.hf_repo}</td><td>\${fmtBytes(v.size_bytes)}</td><td>\${fmtDate(v.uploaded_at)}</td></tr>\`).join('');
}

if (TOKEN) { document.getElementById('login').classList.add('hidden'); document.getElementById('dash').classList.remove('hidden'); loadAll().catch(()=>{}); }
</script>
</body></html>`;
  return new Response(html, { headers: { ...cors, "Content-Type": "text/html;charset=utf-8" } });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
