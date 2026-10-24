#!/usr/bin/env node
// Backend d'agrégation bitchat : une seule connexion par relais (partagée par tous les
// visiteurs du dashboard), persistance SQLite, et retransmission live via son propre
// WebSocket. Pensé pour tourner en local (Docker) — pas exposé publiquement.
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { SocksProxyAgent } from "socks-proxy-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;
// À l'intérieur du conteneur on écoute sur toutes les interfaces (sinon Docker ne peut
// pas relayer le port vers l'hôte) — c'est docker-compose.yml qui garantit que ce port
// n'est publié QUE sur 127.0.0.1 côté machine hôte (voir "ports:" dans ce fichier).
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || "./data/bitchat.db";
const TOR_PROXY = process.env.TOR_PROXY || ""; // ex: socks5h://127.0.0.1:9050
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://h4ckm4p.github.io,http://localhost,http://127.0.0.1"
).split(",").map((s) => s.trim());
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 30;

// annuaire officiel bitchat (permissionlesstech/georelays, nostr_relays.csv), dédupliqué
// (host vs host:443 — cf. georelays issue #14) — snapshot figé dans relays.json, voir
// backend/README.md pour la date et comment le rafraîchir. relay.damus.io en est
// volontairement absent de l'annuaire (probablement écarté pour son rate-limiting
// agressif envers les clients génériques — exactement ce qu'on a subi en direct).
const RELAYS = JSON.parse(readFileSync(join(__dirname, "relays.json"), "utf8"));

const RELAY_HEADERS = { "User-Agent": "Mozilla/5.0", Origin: "https://bitchat-world-view.vercel.app" };

// --- stockage ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT,
    created_at INTEGER,
    received_at INTEGER,
    geohash TEXT,
    nickname TEXT,
    content TEXT,
    is_noise INTEGER,
    relay_origin TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`);
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, created_at, received_at, geohash, nickname, content, is_noise, relay_origin)
  VALUES (@id, @pubkey, @created_at, @received_at, @geohash, @nickname, @content, @is_noise, @relay_origin)
`);
const recentStmt = db.prepare(`
  SELECT id, pubkey, created_at, geohash, nickname, content FROM events
  WHERE is_noise = 0 ORDER BY created_at DESC LIMIT ?
`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM events`);
const countNoiseStmt = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE is_noise = 1`);
const byGeohashStmt = db.prepare(`
  SELECT geohash, COUNT(*) AS n FROM events
  WHERE is_noise = 0 AND geohash IS NOT NULL
  GROUP BY geohash ORDER BY n DESC LIMIT 50
`);
const exportStmt = db.prepare(`
  SELECT id, pubkey, created_at, received_at, geohash, nickname, content FROM events
  WHERE is_noise = 0 AND geohash = ? ORDER BY created_at ASC
`);
const cleanupStmt = db.prepare(`DELETE FROM events WHERE received_at < ?`);

// --- purge périodique : les events bitchat sont du direct, pas une archive sans fin ---
function cleanupOldMessages() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  const { changes } = cleanupStmt.run(cutoff);
  if (changes > 0) console.log(`nettoyage : ${changes} messages de plus de ${RETENTION_DAYS}j supprimés`);
}
cleanupOldMessages();
setInterval(cleanupOldMessages, 60 * 60 * 1000); // toutes les heures

function tagValue(ev, name) {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

// shortcut: même heuristique que le dashboard — un message de chat humain n'est
// quasiment jamais du JSON valide avec un champ "type".
function isNoise(content) {
  const text = (content || "").trim();
  if (!text.startsWith("{")) return false;
  try {
    const obj = JSON.parse(text);
    return typeof obj === "object" && obj !== null && typeof obj.type === "string";
  } catch {
    return false;
  }
}

function toClientShape(row) {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    content: row.content,
    tags: [["g", row.geohash || ""], ["n", row.nickname || ""]],
  };
}

// --- diffusion live aux dashboards connectés ---
const clients = new Set();
function broadcast(ev) {
  const payload = JSON.stringify(ev);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// --- ingestion relais, avec reconnexion à backoff (même logique que le dashboard) ---
const relayOpen = {}; // url -> bool, pour exposer le nombre de nœuds connectés via /api/status
const relayAttempts = {};
const RECONNECT_DELAYS = [500, 1000, 2000, 5000, 15000, 60000, 300000];
const STABLE_AFTER_MS = 60000;
const seenIds = new Set();

function scheduleReconnect(url) {
  const attempt = relayAttempts[url] || 0;
  const base = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
  const delay = base * (0.75 + Math.random() * 0.5);
  setTimeout(() => connectRelay(url), delay);
}

function connectRelay(url) {
  const opts = { headers: RELAY_HEADERS };
  if (TOR_PROXY) opts.agent = new SocksProxyAgent(TOR_PROXY);
  const ws = new WebSocket(url, opts);
  let stableTimer = null;

  ws.on("open", () => {
    relayOpen[url] = true;
    console.log(`[${url}] connecté${TOR_PROXY ? " (via Tor)" : ""}`);
    ws.send(JSON.stringify(["REQ", "ingest", { kinds: [20000] }]));
    stableTimer = setTimeout(() => { relayAttempts[url] = 0; }, STABLE_AFTER_MS);
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg[0] !== "EVENT") return;
    const ev = msg[2];
    if (seenIds.has(ev.id)) return;
    seenIds.add(ev.id);

    const noise = isNoise(ev.content ?? "");
    insertStmt.run({
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at,
      received_at: Math.floor(Date.now() / 1000),
      geohash: tagValue(ev, "g") || null,
      nickname: tagValue(ev, "n") || null,
      content: ev.content ?? "",
      is_noise: noise ? 1 : 0,
      relay_origin: url,
    });
    if (!noise) broadcast(ev);
  });

  // shortcut: toute la logique de reconnexion vit dans "close" — onerror est toujours
  // suivi de "close", donc gérer les deux doublerait les tentatives programmées.
  ws.on("error", () => {});
  ws.on("close", () => {
    relayOpen[url] = false;
    clearTimeout(stableTimer);
    relayAttempts[url] = (relayAttempts[url] || 0) + 1;
    scheduleReconnect(url);
  });
}

// shortcut: étalé sur ~50ms/relais plutôt que tout en même temps — avec 300+ relais,
// ouvrir toutes les connexions à la même milliseconde ressemble à un scan automatisé.
RELAYS.forEach((url, i) => setTimeout(() => connectRelay(url), i * 50));

// --- serveur HTTP (backfill) + WebSocket (live), lié à 127.0.0.1 uniquement ---
function originAllowed(origin) {
  if (!origin) return true; // requêtes locales sans en-tête Origin (curl, etc.)
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    res.writeHead(403).end("origin non autorisée");
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

  if (req.url.startsWith("/api/messages")) {
    const limit = Math.min(2000, Number(new URL(req.url, "http://x").searchParams.get("limit")) || 500);
    const rows = recentStmt.all(limit).map(toClientShape);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(rows));
    return;
  }
  if (req.url === "/health") {
    res.end("ok");
    return;
  }
  if (req.url === "/api/status") {
    const connected = Object.values(relayOpen).filter(Boolean).length;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ relaysConnected: connected, relaysTotal: RELAYS.length }));
    return;
  }
  if (req.url === "/api/stats") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      totalMessages: countStmt.get().n,
      totalNoise: countNoiseStmt.get().n,
      retentionDays: RETENTION_DAYS,
      byGeohash: byGeohashStmt.all(),
    }));
    return;
  }
  if (req.url.startsWith("/api/export")) {
    const params = new URL(req.url, "http://x").searchParams;
    const geohash = params.get("geohash");
    const format = params.get("format") === "csv" ? "csv" : "json";
    if (!geohash) {
      res.writeHead(400).end("paramètre geohash requis");
      return;
    }
    const rows = exportStmt.all(geohash);
    const filename = `bitchat-${geohash}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = "id,pubkey,created_at,received_at,geohash,nickname,content\n";
      const body = rows.map((r) =>
        [r.id, r.pubkey, r.created_at, r.received_at, r.geohash, r.nickname, r.content].map(esc).join(",")
      ).join("\n");
      res.end(header + body);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rows, null, 2));
    }
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info) => originAllowed(info.origin),
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`backend bitchat sur http://${HOST}:${PORT} — publié sur l'hôte via docker-compose (127.0.0.1 uniquement, voir ports:)`);
  if (TOR_PROXY) console.log(`sortie relais via proxy Tor : ${TOR_PROXY}`);
});
