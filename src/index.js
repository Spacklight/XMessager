/**
 * XMessager backend — Cloudflare Worker
 * Accepts short marketing video uploads and commits them straight into a
 * Hugging Face Dataset repo using HF's Commit API (plain fetch, no SDK needed).
 *
 * Bindings expected (set in wrangler.toml / dashboard):
 *   env.HF_TOKEN         - Hugging Face access token (write scope), set as a secret
 *   env.HF_DATASET_REPO  - e.g. "yourname/xmessager-videos"
 *   env.VIDEO_KV         - (optional) KV namespace for fast video listing/metadata
 */

const MAX_INLINE_BYTES = 20 * 1024 * 1024; // 20MB

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
      {
        error: `File too large for this endpoint (${(buf.byteLength / 1e6).toFixed(1)}MB, limit ${MAX_INLINE_BYTES / 1e6}MB).`,
        hint: "Large files need the Git LFS multipart upload flow instead of the inline commit API.",
      },
      413,
      cors
    );
  }

  const id = crypto.randomUUID();
  const nameParts = (file.name || "video.mp4").split(".");
  const ext = (nameParts.length > 1 ? nameParts.pop() : "mp4").toLowerCase();
  const path = `videos/${id}.${ext}`;
  const base64 = arrayBufferToBase64(buf);

  const commitBody =
    JSON.stringify({
      key: "header",
      value: { summary: `Upload video ${id}`, description: `title=${title}; uploader=${uploader}` },
    }) +
    "\n" +
    JSON.stringify({ key: "file", value: { content: base64, path, encoding: "base64" } });

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
    return json({ error: "Hugging Face upload failed", details }, hfRes.status, cors);
  }

  const videoUrl = `https://huggingface.co/datasets/${env.HF_DATASET_REPO}/resolve/main/${path}`;
  const record = { id, title, uploader, path, url: videoUrl, uploadedAt: Date.now() };

  if (env.VIDEO_KV) {
    await env.VIDEO_KV.put(id, JSON.stringify(record));
  }

  return json(record, 200, cors);
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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
