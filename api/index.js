// Xtream Codes API Proxy – turn your single M3U into Xtream-like endpoints
// Deploy on Vercel / Render / any Node host
// Endpoints:
//  - /get.php?username=U&password=P&type=m3u_plus&output=ts  → returns your M3U (optionally personalized)
//  - /player_api.php?username=U&password=P                 → returns Xtream-style JSON built from your M3U
//
// Setup:
//   1) Set env SOURCE_M3U_URL to your central M3U link (e.g., https://bit.ly/tvbox825)
//   2) (Optional) Set ALLOW_USERS comma-separated list to restrict access: user1:pass1,user2:pass2
//   3) Deploy. Test with: https://<your-domain>/get.php?username=test&password=test&type=m3u_plus
//
// Notes:
// - This is a lightweight emulator so apps that need Xtream Codes can log in and list channels.
// - We do not host streams; we just expose your existing links from the M3U.

import express from "express";
import { request as undiciRequest } from "undici";

const app = express();

const SOURCE_M3U_URL = process.env.SOURCE_M3U_URL; // required
if (!SOURCE_M3U_URL) {
  console.error("Missing SOURCE_M3U_URL env var");
}

// Parse ALLOW_USERS env to a Map of username -> password. Empty means allow any.
function parseAllowUsers() {
  const raw = process.env.ALLOW_USERS || "";
  const map = new Map();
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [u, p] = pair.split(":");
      if (u) map.set(u, p || "");
    });
  return map;
}
const ALLOW_USERS = parseAllowUsers();

// Simple in-memory cache (per instance). For serverless, it's per cold start.
let cache = {
  m3uText: null,
  parsed: null,
  fetchedAt: 0,
};
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 min

async function fetchM3U() {
  const now = Date.now();
  if (cache.m3uText && now - cache.fetchedAt < CACHE_TTL_MS) return cache.m3uText;
  const res = await undiciRequest(SOURCE_M3U_URL, { method: "GET" });
  if (res.statusCode >= 400) throw new Error(`Upstream M3U fetch failed: ${res.statusCode}`);
  const text = await res.body.text();
  cache.m3uText = text;
  cache.parsed = parseM3U(text);
  cache.fetchedAt = now;
  return text;
}

function okUserPass(user, pass) {
  if (ALLOW_USERS.size === 0) return true; // open mode
  const allowedPass = ALLOW_USERS.get(user);
  return typeof allowedPass !== "undefined" && allowedPass === (pass || "");
}

// Tiny M3U parser for #EXTM3U with #EXTINF attributes used by IPTV
function parseAttributes(attrLine) {
  // attrLine example: tvg-id="xxx" tvg-name="yyy" group-title="News" tvg-logo="http://..."
  const attrs = {};
  const re = /(\w[\w-]*)=\"([^\"]*)\"/g;
  let m;
  while ((m = re.exec(attrLine)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      // Extract duration, attrs and title
      // e.g. #EXTINF:-1 tvg-id="id" tvg-name="name" tvg-logo="logo" group-title="grp", Channel Name
      const after = line.substring("#EXTINF:".length);
      const commaIdx = after.indexOf(",");
      const meta = commaIdx >= 0 ? after.substring(0, commaIdx).trim() : after.trim();
      const title = commaIdx >= 0 ? after.substring(commaIdx + 1).trim() : "";
      const attrs = parseAttributes(meta);
      current = {
        name: attrs["tvg-name"] || title || attrs["tvg-id"] || "Unnamed",
        title,
        attrs,
        url: null,
      };
    } else if (current && !line.startsWith("#")) {
      // This should be the stream URL for the previous EXTINF
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  // Assign ids
  return channels.map((c, idx) => ({
    id: String(idx + 1),
    stream_id: idx + 1,
    name: c.name,
    title: c.title,
    tvg_id: c.attrs["tvg-id"] || null,
    tvg_logo: c.attrs["tvg-logo"] || null,
    group_title: c.attrs["group-title"] || "Other",
    direct_source: c.url,
  }));
}

function xtreamServerInfo(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return {
    url: `${proto}://${host}`,
    server_protocol: proto,
    rtmp_port: 0,
    timezone: "UTC",
    timestamp_now: Math.floor(Date.now() / 1000),
    time_now: new Date().toISOString(),
    port: proto === "https" ? 443 : 80,
    https_port: 443,
  };
}

app.get("/get.php", async (req, res) => {
  try {
    const { username = "", password = "", type = "m3u_plus" } = req.query;
    if (!okUserPass(String(username), String(password))) {
      res.status(401).send("#EXTM3U\n# Access denied");
      return;
    }
    const m3u = await fetchM3U();
    // Optional: personalize by replacing a token, e.g., {{username}}
    const personalized = m3u.replaceAll("{{username}}", String(username)).replaceAll("{{password}}", String(password));
    // Force m3u_plus header just in case some players expect it
    let out = personalized;
    if (!out.startsWith("#EXTM3U")) out = `#EXTM3U\n${out}`;
    res.setHeader("Content-Type", type === "m3u_plus" ? "application/x-mpegURL" : "text/plain");
    res.send(out);
  } catch (e) {
    res.status(500).send(`#EXTM3U\n# Error: ${(e && e.message) || e}`);
  }
});

app.get("/player_api.php", async (req, res) => {
  try {
    const { username = "", password = "" } = req.query;
    const u = String(username);
    const p = String(password);
    const allowed = okUserPass(u, p);

    // Build skeleton user_info
    const status = allowed ? "Active" : "Disabled";
    const user_info = {
      username: u,
      password: p,
      auth: allowed ? 1 : 0,
      status,
      is_trial: 0,
      active_cons: 1,
      exp_date: null,
      created_at: Math.floor(Date.now() / 1000),
    };

    const server_info = xtreamServerInfo(req);

    let available_channels = [];
    if (allowed) {
      await fetchM3U();
      available_channels = (cache.parsed || []).map((c) => ({
        name: c.name,
        stream_id: c.stream_id,
        stream_type: "live",
        stream_icon: c.tvg_logo,
        epg_channel_id: c.tvg_id,
        added: new Date().toISOString().slice(0, 19).replace("T", " "),
        category_id: c.group_title,
        custom_sid: null,
        direct_source: c.direct_source,
      }));
    }

    res.json({ user_info, server_info, available_channels });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || String(e) });
  }
});

// Optional: basic index
app.get("/", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  res.type("text/plain").send(`Xtream Proxy OK\n\nTry:\n/${"get.php"}?username=test&password=test&type=m3u_plus\n/${"player_api.php"}?username=test&password=test\n`);
});

// Vercel: export default handler
export default app;

// If running locally: node server.js (with module type=module) and uncomment below
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`Listening on ${PORT}`));
