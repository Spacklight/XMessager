/**
 * XMessager backend — Cloudflare Worker
 * Accepts short marketing video uploads and pushes them into a Hugging Face
 * Dataset repo using the Git LFS batch protocol (required for binary files —
 * HF rejects videos pushed as plain "file" commit blobs).
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *   env.HF_TOKEN         - Hugging Face access token (write scope), set as a secret
 *   env.HF_DATASET_REPO  - e.g. "Spacklight/Video-data"
 *   env.VIDEO_KV         - (optional) KV namespace for fast video listing/metadata
 */

const MAX_INLINE_BYTES = 50 * 1024 * 1024; // 50MB per upload

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
        return await listVideos(env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500, cors);
    }
  },
};

async function handleUpload(request, env, cors) {
  if (!env.HF_TOKEN || !env.HF_DATASET_REPO) {
    return json({ error: "Server misconfigured: HF_TOKEN / HF_DATASET_REPO not set" }, 500, cors);
  }

  const form = await request.formData();
  const file = form.get("video");
  const title = (form.get("title") || "untitled").toString();
  const uploader = (form.get("uploader") || "anonymous").toString();

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

  const id = crypto.randomUUID();
  const nameParts = (file.name || "video.mp4").split(".");
  const ext = (nameParts.length > 1 ? nameParts.pop() : "mp4").toLowerCase();
  const path = `videos/${id}.${ext}`;

  let oid, size;
  try {
    ({ oid, size } = await uploadViaLfs(env, env.HF_DATASET_REPO, buf, path));
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

  const hfRes = await fetch(`https://huggingface.co/api/datasets/${env.HF_DATASET_REPO}/commit/main`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.HF_TOKEN}`,
      "Content-Type": "application/x-ndjson",
    },
    body: commitBody,
  });

  if (!hfRes.ok) {
    const details = await hfRes.text();
    return json({ error: "Hugging Face commit failed", details }, hfRes.status, cors);
  }

  const videoUrl = `https://huggingface.co/datasets/${env.HF_DATASET_REPO}/resolve/main/${path}`;
  const record = { id, title, uploader, path, url: videoUrl, uploadedAt: Date.now() };

  if (env.VIDEO_KV) {
    await env.VIDEO_KV.put(id, JSON.stringify(record));
  }

  return json(record, 200, cors);
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
    body: JSON.stringify({
      operation: "upload",
      transfers: ["basic"],
      objects: [{ oid, size }],
      hash_algo: "sha256",
    }),
  });

  if (!batchRes.ok) {
    throw new Error(`LFS batch request failed: ${await batchRes.text()}`);
  }

  const batchJson = await batchRes.json();
  const obj = batchJson.objects && batchJson.objects[0];
  if (!obj) throw new Error("LFS batch response missing object info");
  if (obj.error) throw new Error(`LFS batch error: ${obj.error.message}`);

  if (obj.actions && obj.actions.upload) {
    const upload = obj.actions.upload;
    const putRes = await fetch(upload.href, {
      method: "PUT",
      headers: upload.header || {},
      body: buf,
    });
    if (!putRes.ok) {
      throw new Error(`LFS object upload failed: ${putRes.status} ${await putRes.text()}`);
    }
  }
  // If actions.upload is absent, HF already has this exact object (dedup) — nothing to upload.

  return { oid, size };
}

async function listVideos(env, cors) {
  if (env.VIDEO_KV) {
    const list = await env.VIDEO_KV.list();
    const items = await Promise.all(
      list.keys.map(async (k) => JSON.parse(await env.VIDEO_KV.get(k.name)))
    );
    items.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return json({ videos: items }, 200, cors);
  }

  const res = await fetch(
    `https://huggingface.co/api/datasets/${env.HF_DATASET_REPO}/tree/main/videos`,
    { headers: { Authorization: `Bearer ${env.HF_TOKEN}` } }
  );
  if (!res.ok) return json({ error: "Could not list videos from Hugging Face" }, res.status, cors);
  const files = await res.json();
  return json({ videos: files }, 200, cors);
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
