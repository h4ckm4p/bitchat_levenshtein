#!/usr/bin/env node
// Backend d'agrégation bitchat : une seule connexion par relais (partagée par tous les
// visiteurs du dashboard), persistance SQLite, et retransmission live via son propre
// WebSocket. Pensé pour tourner en local (Docker) — pas exposé publiquement.
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync, createWriteStream, createReadStream, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SocksProxyAgent } from "socks-proxy-agent";
import ngeohash from "ngeohash";
import { GEOHASH_RE, isNoise, isValidSignedEvent, levenshtein, matches, parseQuery, matchesOne } from "./filters.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- traduction geohash -> lieu lisible (100% hors-ligne, aucun appel externe de
// géocodage : ça enverrait les zones surveillées à un tiers, contraire à l'anonymat
// recherché ici). Précision déduite de la longueur du geohash (cf. doc bitchat :
// 7=bloc, 6=quartier, 5=ville, 4=province, <=2=région), ville la plus proche cherchée
// dans une petite liste embarquée (backend/cities.json) via distance à vol d'oiseau.
const CITIES = JSON.parse(readFileSync(join(__dirname, "cities.json"), "utf8"));

function precisionLabel(geohash) {
  const len = (geohash || "").length;
  if (len >= 7) return "bloc";
  if (len === 6) return "quartier";
  if (len === 5) return "ville";
  if (len === 4) return "province";
  if (len > 0 && len <= 2) return "région";
  return "zone";
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// shortcut: ~150 villes majeures seulement (pas de dataset mondial exhaustif, pour
// rester léger et 100% embarqué) -- une zone loin de toute grande ville peut remonter
// une ville à plusieurs dizaines/centaines de km, d'où la distance affichée.
function describeGeohash(geohash) {
  if (!geohash) return null;
  let point;
  try { point = ngeohash.decode(geohash); } catch { return null; }
  if (!point || Number.isNaN(point.latitude)) return null;
  let nearest = null, best = Infinity;
  for (const c of CITIES) {
    const d = haversineKm(point.latitude, point.longitude, c.lat, c.lon);
    if (d < best) { best = d; nearest = c; }
  }
  const precision = precisionLabel(geohash);
  // un geohash de 1-3 caractères couvre une cellule de 100 à 5000km de large (ex: "u0"
  // couvre quasiment toute l'Europe de l'Ouest) -- même le pays du centre de cellule s'est
  // révélé trompeur ici (ex: "u1" résolu en "Pays-Bas" alors que la cellule couvre aussi
  // le nord de la France, la Belgique et l'Allemagne) : pas de ville ni de pays à ce
  // niveau de zoom, juste le label de précision brut.
  if ((geohash.length || 0) <= 3) return precision;
  return nearest ? `${precision} — près de ${nearest.name} (${Math.round(best)}km)` : precision;
}

const PORT = process.env.PORT || 8787;
// À l'intérieur du conteneur on écoute sur toutes les interfaces (sinon Docker ne peut
// pas relayer le port vers l'hôte) — c'est docker-compose.yml qui garantit que ce port
// n'est publié QUE sur 127.0.0.1 côté machine hôte (voir "ports:" dans ce fichier).
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || "./data/bitchat.db";
const TOR_PROXY = process.env.TOR_PROXY || ""; // ex: socks5h://127.0.0.1:9050
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "http://localhost,http://127.0.0.1"
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
  CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
  CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
`);
// migrations : colonnes ajoutées après la création initiale de la table
const existingCols = db.prepare(`PRAGMA table_info(events)`).all().map((c) => c.name);
if (!existingCols.includes("location")) db.exec(`ALTER TABLE events ADD COLUMN location TEXT`);
if (!existingCols.includes("teleported")) db.exec(`ALTER TABLE events ADD COLUMN teleported INTEGER DEFAULT 0`);
if (!existingCols.includes("kept")) db.exec(`ALTER TABLE events ADD COLUMN kept INTEGER DEFAULT 0`);
if (!existingCols.includes("kept_note")) db.exec(`ALTER TABLE events ADD COLUMN kept_note TEXT`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO events (id, pubkey, created_at, received_at, geohash, nickname, content, is_noise, relay_origin, location, teleported)
  VALUES (@id, @pubkey, @created_at, @received_at, @geohash, @nickname, @content, @is_noise, @relay_origin, @location, @teleported)
`);
// tri par received_at (horodatage serveur à l'ingestion), pas created_at (déclaré par
// l'auteur du message -- non fiable : fuseau horaire ou horloge locale mal réglée côté
// client bitchat peuvent faire apparaître un message avant des messages plus anciens).
const recentStmt = db.prepare(`
  SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
  WHERE is_noise = 0 ORDER BY received_at DESC LIMIT ?
`);
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM events`);
const countNoiseStmt = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE is_noise = 1`);
const byGeohashStmt = db.prepare(`
  SELECT geohash, COUNT(*) AS n FROM events
  WHERE is_noise = 0 AND geohash IS NOT NULL
  GROUP BY geohash ORDER BY n DESC LIMIT 50
`);
// export : tout l'historique non-bruit, filtré ensuite en JS par terme+distance (pas en SQL,
// la distance de Levenshtein n'a pas d'équivalent simple en SQL -- cf. matches() plus bas)
const exportAllStmt = db.prepare(`
  SELECT id, pubkey, created_at, received_at, geohash, location, nickname, content, teleported, kept, kept_note FROM events
  WHERE is_noise = 0 ORDER BY received_at ASC
`);
// kept=1 (message "gardé", voir /api/keep) exclu de la purge -- un message mis de côté
// pour un dossier précis ne doit pas disparaître au bout de RETENTION_DAYS comme le reste.
const cleanupStmt = db.prepare(`DELETE FROM events WHERE received_at < ? AND kept = 0`);
const keepStmt = db.prepare(`UPDATE events SET kept = 1, kept_note = ? WHERE id = ?`);
const unkeepStmt = db.prepare(`UPDATE events SET kept = 0, kept_note = NULL WHERE id = ?`);
const keptListStmt = db.prepare(`
  SELECT id, pubkey, created_at, received_at, geohash, location, nickname, content, teleported, kept, kept_note FROM events
  WHERE kept = 1 ORDER BY received_at DESC
`);

// nickname/content viennent d'auteurs Nostr non authentifiés -- préfixer d'une apostrophe
// un champ commençant par =, +, -, @ (ou tab/CR) empêche un tableur (Excel/Sheets/
// LibreOffice) d'interpréter une formule piégée à l'ouverture (ex: =HYPERLINK(...)) --
// mitigation standard CSV injection, partagée par tous les exports CSV.
function escCsv(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// --- purge périodique : les events bitchat sont du direct, pas une archive sans fin ---
function cleanupOldMessages() {
  const cutoff = Math.floor(Date.now() / 1000) - RETENTION_DAYS * 86400;
  const { changes } = cleanupStmt.run(cutoff);
  if (changes > 0) console.log(`nettoyage : ${changes} messages de plus de ${RETENTION_DAYS}j supprimés`);
}
// nettoyage des spams "même message, même canal" : un contenu identique posté plusieurs
// fois sur le même geohash est du bruit quand il vient de peu d'identités différentes
// (flood depuis quelques comptes) -- pas quand beaucoup de personnes différentes tapent
// spontanément la même chose courte (ex: ".", "oui"). Deux signaux combinés :
// - peu de pseudos distincts pour le nombre de répétitions (<=3, ou ratio répétitions/
//   pseudos élevé -- couvre aussi un bot qui répond au même contenu à des déclencheurs
//   différents, ex: "ZoukMachine" rejouant les mêmes paroles 292 fois pour 11 pseudos) ;
// - longueur mini de 8 caractères, pour ne jamais confondre un vrai flood avec une
//   réaction courte (".", "oui", "lol") que plusieurs humains tapent par coïncidence.
const DUPLICATE_SPAM_STMT = db.prepare(`
  SELECT geohash, content, COUNT(*) AS n, COUNT(DISTINCT nickname) AS dn
  FROM events
  WHERE is_noise = 0 AND geohash IS NOT NULL AND length(trim(content)) >= 8
  GROUP BY geohash, content
  HAVING n >= 5 AND (dn <= 3 OR CAST(n AS REAL) / dn >= 5)
`);
const MARK_DUPLICATE_NOISE_STMT = db.prepare(
  `UPDATE events SET is_noise = 1 WHERE geohash = ? AND content = ? AND is_noise = 0`
);
function reclassifyDuplicateSpam() {
  const groups = DUPLICATE_SPAM_STMT.all();
  let total = 0;
  db.transaction((gs) => {
    for (const g of gs) {
      const { changes } = MARK_DUPLICATE_NOISE_STMT.run(g.geohash, g.content);
      total += changes;
    }
  })(groups);
  if (total > 0) console.log(`nettoyage spam : ${total} messages dupliqués (${groups.length} motifs) requalifiés en bruit`);
}

// calcule le lieu des messages insérés avant l'ajout de cette fonctionnalité
function backfillLocations() {
  const rows = db.prepare(
    `SELECT id, geohash FROM events WHERE location IS NULL AND geohash IS NOT NULL`
  ).all();
  const update = db.prepare(`UPDATE events SET location = ? WHERE id = ?`);
  db.transaction((rs) => {
    for (const r of rs) update.run(describeGeohash(r.geohash), r.id);
  })(rows);
  if (rows.length > 0) console.log(`${rows.length} messages existants complétés avec leur lieu`);
}

cleanupOldMessages();
setInterval(cleanupOldMessages, 60 * 60 * 1000); // toutes les heures
reclassifyNoise();
backfillLocations();
reclassifyDuplicateSpam();
setInterval(reclassifyDuplicateSpam, 10 * 60 * 1000); // un flood en cours doit être nettoyé vite, pas au prochain redémarrage

function tagValue(ev, name) {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

// reclassifie rétroactivement ce que l'ancien filtre (plus étroit) avait laissé passer
function reclassifyNoise() {
  const candidates = db.prepare(`SELECT id, content, nickname FROM events WHERE is_noise = 0`).all();
  const markNoise = db.prepare(`UPDATE events SET is_noise = 1 WHERE id = ?`);
  let n = 0;
  db.transaction((rows) => {
    for (const r of rows) if (isNoise(r.content, r.nickname)) { markNoise.run(r.id); n++; }
  })(candidates);
  if (n > 0) console.log(`reclassification : ${n} messages requalifiés en bruit (filtre élargi)`);
}

function toClientShape(row) {
  const tags = [["g", row.geohash || ""], ["n", row.nickname || ""]];
  if (row.teleported) tags.push(["t", "teleport"]); // tag officiel bitchat (cf. NostrProtocol.swift)
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    received_at: row.received_at,
    content: row.content,
    location: row.location,
    kept: !!row.kept,
    kept_note: row.kept_note ?? null,
    tags,
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
let invalidSignatureCount = 0; // visible via /api/status

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

    // recalcule l'id NIP-01 et vérifie la signature schnorr (BIP-340) avant toute autre
    // chose -- un relais malveillant ou en défaut pourrait pousser un événement falsifié ;
    // rejeter ici donne une vraie valeur probante à ce qui est stocké (cf. filters.mjs).
    if (!isValidSignedEvent(ev)) { invalidSignatureCount++; return; }

    const geohash = tagValue(ev, "g") || null;
    // kind 20000 est partagé avec d'autres applis Nostr (pas réservé à bitchat) -- sans
    // tag g valide, ce n'est pas un message de canal bitchat, on ne le stocke pas du tout
    // (contrairement au bruit habituel qui lui est stocké et masqué, pas pertinent ici).
    if (!geohash || !GEOHASH_RE.test(geohash)) return;

    const nickname = tagValue(ev, "n") || null;
    const noise = isNoise(ev.content ?? "", nickname);
    const location = describeGeohash(geohash);
    // tag officiel bitchat ["t","teleport"] : présent quand l'auteur poste dans ce canal
    // geohash sans y être physiquement (cf. NostrProtocol.swift / GeohashMessageHandler.kt)
    const teleported = ev.tags.some((t) => t[0] === "t" && t[1] === "teleport");
    const received_at = Math.floor(Date.now() / 1000);
    insertStmt.run({
      id: ev.id,
      pubkey: ev.pubkey,
      created_at: ev.created_at,
      received_at,
      geohash,
      nickname,
      content: ev.content ?? "",
      is_noise: noise ? 1 : 0,
      relay_origin: url,
      location,
      teleported: teleported ? 1 : 0,
    });
    if (!noise) broadcast({ ...ev, location, received_at });
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
// shortcut: comparaison exacte du host (hostname + protocole), port ignoré -- un simple
// startsWith() était contournable ("http://localhost.evil.com".startsWith("http://localhost")
// vaut true en JS), ce qui laissait n'importe quel site web lire toute la base via ce
// backend si l'utilisateur le visitait pendant que le backend tournait en local.
function originAllowed(origin) {
  if (!origin) return true; // requêtes locales sans en-tête Origin (curl, etc.)
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  return ALLOWED_ORIGINS.some((o) => {
    try {
      const allowed = new URL(o);
      return parsed.protocol === allowed.protocol && parsed.hostname === allowed.hostname;
    } catch { return false; }
  });
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    res.writeHead(403).end("origin non autorisée");
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);

  // requête de préflight CORS (déclenchée par tout POST avec un header Content-Type
  // "non simple" comme application/json, ex: /api/keep, /api/unkeep) -- sans cette
  // réponse explicite, le navigateur reçoit un 404 du fallback plus bas et bloque la
  // vraie requête avant même qu'elle parte (erreur "Failed to fetch" côté client).
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.writeHead(204).end();
    return;
  }

  if (req.url.startsWith("/api/messages")) {
    const limit = Math.min(10000, Number(new URL(req.url, "http://x").searchParams.get("limit")) || 500);
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
    res.end(JSON.stringify({ relaysConnected: connected, relaysTotal: RELAYS.length, invalidSignatureCount }));
    return;
  }
  if (req.url === "/api/stats") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      totalMessages: countStmt.get().n,
      totalNoise: countNoiseStmt.get().n,
      retentionDays: RETENTION_DAYS,
      byGeohash: byGeohashStmt.all().map((r) => ({ ...r, label: describeGeohash(r.geohash) })),
    }));
    return;
  }
  if (req.url.startsWith("/api/channel")) {
    const params = new URL(req.url, "http://x").searchParams;
    const geohash = params.get("geohash");
    if (!geohash) { res.writeHead(400).end("paramètre geohash requis"); return; }
    const limit = Math.min(2000, Number(params.get("limit")) || 500);
    const around = Number(params.get("around")) || null;
    let rows;
    if (around) {
      // un canal très actif peut dépasser `limit` messages en quelques minutes --
      // "les N plus récents" ne remonte alors jamais jusqu'à un message cliqué plus
      // ancien. On centre la fenêtre sur son horodatage (moitié avant, moitié après)
      // au lieu de se baser uniquement sur le présent.
      // centré/trié par received_at (horodatage serveur), pas created_at (déclaré par
      // l'auteur, non fiable selon son fuseau/horloge -- cf. recentStmt plus haut).
      const half = Math.ceil(limit / 2);
      const before = db.prepare(`
        SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
        WHERE is_noise = 0 AND geohash = ? AND received_at <= ? ORDER BY received_at DESC LIMIT ?
      `).all(geohash, around, half);
      const after = db.prepare(`
        SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
        WHERE is_noise = 0 AND geohash = ? AND received_at > ? ORDER BY received_at ASC LIMIT ?
      `).all(geohash, around, half);
      rows = [...after.reverse(), ...before]; // tri global décroissant, comme le cas sans `around`
    } else {
      rows = db.prepare(`
        SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
        WHERE is_noise = 0 AND geohash = ? ORDER BY received_at DESC LIMIT ?
      `).all(geohash, limit);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ geohash, label: describeGeohash(geohash), messages: rows.map(toClientShape) }));
    return;
  }
  if (req.url.startsWith("/api/author")) {
    // tous les messages d'un auteur, tous canaux confondus -- identifié par pubkey (pas
    // le pseudo affiché, que plusieurs comptes différents peuvent partager).
    const params = new URL(req.url, "http://x").searchParams;
    const pubkey = params.get("pubkey");
    const nickname = params.get("nickname");
    if (!pubkey) { res.writeHead(400).end("paramètre pubkey requis"); return; }
    const limit = Math.min(2000, Number(params.get("limit")) || 500);
    const rows = db.prepare(`
      SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
      WHERE is_noise = 0 AND pubkey = ? ORDER BY received_at DESC LIMIT ?
    `).all(pubkey, limit);
    // messages d'autres comptes (pubkey différente) ayant affiché le même pseudo --
    // bitchat n'a pas d'identité vérifiée, un pseudo n'appartient à personne : utile à
    // voir mais jamais à confondre avec le même auteur, donc renvoyé à part.
    let otherAccountRows = [];
    if (nickname) {
      otherAccountRows = db.prepare(`
        SELECT id, pubkey, created_at, received_at, geohash, nickname, content, location, teleported, kept, kept_note FROM events
        WHERE is_noise = 0 AND nickname = ? AND pubkey != ? ORDER BY received_at DESC LIMIT ?
      `).all(nickname, pubkey, limit);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      pubkey,
      messages: rows.map(toClientShape),
      samePseudoOtherAccounts: otherAccountRows.map(toClientShape),
    }));
    return;
  }
  if (req.url.startsWith("/api/search")) {
    // backfill d'une colonne : cherche le terme dans TOUT l'historique retenu, pas
    // seulement dans les N derniers messages génériques (sinon un terme peu fréquent,
    // ex: le nom d'une ville précise, se retrouve noyé bien avant la fenêtre récente
    // dès que la base grossit -- c'est exactement le bug observé en conditions réelles).
    const params = new URL(req.url, "http://x").searchParams;
    const term = params.get("term");
    if (!term) { res.writeHead(400).end("paramètre term requis"); return; }
    const dist = Number(params.get("dist")) || 0;
    const limit = Math.min(5000, Number(params.get("limit")) || 2000);
    const rows = exportAllStmt.all().filter((r) => matches(r.content, term, dist));
    const recent = rows.slice(-limit).map(toClientShape); // exportAllStmt est trié du plus ancien au plus récent
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(recent));
    return;
  }
  if (req.url.startsWith("/api/export/kept")) {
    // export dédié des messages "gardés" (voir /api/keep) avec leur note -- indépendant
    // d'une recherche, pour extraire le dossier constitué au fil de la veille. Doit être
    // vérifié AVANT le "/api/export" générique ci-dessous (startsWith l'avalerait sinon).
    const format = new URL(req.url, "http://x").searchParams.get("format") === "csv" ? "csv" : "json";
    const rows = keptListStmt.all();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="bitchat-gardes-${date}.${format}"`);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      const header = "id,pubkey,created_at,received_at,geohash,location,teleported,nickname,content,note\n";
      const body = rows.map((r) =>
        [r.id, r.pubkey, r.created_at, r.received_at, r.geohash, r.location, r.teleported ? "oui" : "non", r.nickname, r.content, r.kept_note]
          .map(escCsv).join(",")
      ).join("\n");
      res.end(header + body);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rows.map(toClientShape), null, 2));
    }
    return;
  }
  if (req.url.startsWith("/api/export")) {
    // export des messages d'une RECHERCHE (terme + distance, comme une colonne du
    // dashboard), pas d'un geohash brut -- mêmes règles de correspondance qu'à l'écran.
    const params = new URL(req.url, "http://x").searchParams;
    const term = params.get("term");
    const dist = Number(params.get("dist")) || 0;
    const format = params.get("format") === "csv" ? "csv" : "json";
    if (!term) {
      res.writeHead(400).end("paramètre term requis");
      return;
    }
    const rows = exportAllStmt.all().filter((r) => matches(r.content, term, dist));
    const safeTerm = term.replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "recherche";
    const filename = `bitchat-${safeTerm}.${format}`;
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      const header = "id,pubkey,created_at,received_at,geohash,location,teleported,nickname,content\n";
      const body = rows.map((r) =>
        [r.id, r.pubkey, r.created_at, r.received_at, r.geohash, r.location, r.teleported ? "oui" : "non", r.nickname, r.content].map(escCsv).join(",")
      ).join("\n");
      res.end(header + body);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(rows, null, 2));
    }
    return;
  }
  if (req.url === "/api/kept") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(keptListStmt.all().map(toClientShape)));
    return;
  }
  if (req.url === "/api/keep" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400).end("JSON invalide"); return; }
      if (!data.id) { res.writeHead(400).end("id requis"); return; }
      const note = typeof data.note === "string" ? data.note.slice(0, 2000) : null;
      keepStmt.run(note, data.id);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url === "/api/unkeep" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400).end("JSON invalide"); return; }
      if (!data.id) { res.writeHead(400).end("id requis"); return; }
      unkeepStmt.run(data.id);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url.startsWith("/api/db/export")) {
    // VACUUM INTO fusionne le WAL et produit un fichier .db autonome et cohérent, sans
    // arrêter le serveur ni risquer de copier une base à moitié écrite en plein milieu
    // d'une insertion -- la config (colonnes/liste noire, dans localStorage du navigateur)
    // n'est volontairement pas incluse : seule la base de messages se partage.
    const tmpPath = join(dirname(DB_PATH), `export-${randomUUID()}.db`);
    try {
      db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } catch (e) {
      res.writeHead(500).end("export impossible : " + e.message);
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="bitchat-export-${date}.db"`);
    const stream = createReadStream(tmpPath);
    stream.pipe(res);
    const cleanup = () => { try { unlinkSync(tmpPath); } catch {} };
    stream.on("close", cleanup);
    stream.on("error", cleanup);
    return;
  }
  if (req.url.startsWith("/api/db/import")) {
    // fusion non-destructive : INSERT OR IGNORE sur l'id (clé primaire) ne touche jamais
    // aux messages déjà présents, n'ajoute que ceux absents de la base actuelle -- importer
    // la base de quelqu'un d'autre ne peut jamais effacer ou écraser les tiens.
    const tmpPath = join(dirname(DB_PATH), `import-${randomUUID()}.db`);
    const writeStream = createWriteStream(tmpPath);
    const MAX_IMPORT_BYTES = 5 * 1024 * 1024 * 1024; // 5 Go, généreux mais pas illimité
    let bytesReceived = 0;
    let aborted = false;
    const cleanup = () => { try { unlinkSync(tmpPath); } catch {} };
    req.on("data", (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > MAX_IMPORT_BYTES && !aborted) {
        aborted = true;
        req.destroy();
        writeStream.destroy();
        cleanup();
        res.writeHead(413).end("fichier trop volumineux");
      }
    });
    req.on("error", cleanup);
    writeStream.on("finish", () => {
      if (aborted) return;
      try {
        db.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS imported`);
        let added = 0;
        try {
          const info = db.prepare(`
            INSERT OR IGNORE INTO events
              (id, pubkey, created_at, received_at, geohash, nickname, content, is_noise, relay_origin, location, teleported)
            SELECT id, pubkey, created_at, received_at, geohash, nickname, content, is_noise, relay_origin, location, teleported
            FROM imported.events
          `).run();
          added = info.changes;
        } finally {
          db.exec(`DETACH DATABASE imported`);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ added }));
      } catch (e) {
        res.writeHead(400).end("import impossible (fichier invalide ou schéma incompatible) : " + e.message);
      } finally {
        cleanup();
      }
    });
    req.pipe(writeStream);
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
