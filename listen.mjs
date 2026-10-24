#!/usr/bin/env node
// Écoute en direct les messages publics bitchat (canaux geohash via Nostr, kind 20000)
// et affiche uniquement ceux qui contiennent un des termes donnés.
//
// Usage: node listen.mjs <terme1> [terme2] [...]
import WebSocket from "ws";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
];

// shortcut: certains relais (dont relay.damus.io) rejettent les connexions
// sans en-têtes "navigateur" (ex: 503) — ces en-têtes les imitent.
const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Origin: "https://bitchat-world-view.vercel.app",
};

const terms = process.argv.slice(2).map((t) => t.toLowerCase());
if (terms.length === 0) {
  console.error("Usage: node listen.mjs <terme1> [terme2] [...]");
  process.exit(1);
}

function tag(ev, name) {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

console.log(`Écoute en direct — termes : ${terms.join(", ")}\n`);

const seen = new Set();

for (const url of RELAYS) {
  const ws = new WebSocket(url, { headers: HEADERS });
  ws.on("open", () => ws.send(JSON.stringify(["REQ", "listen", { kinds: [20000] }])));
  ws.on("error", (e) => console.error(`[${url}] erreur: ${e.message}`));
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg[0] !== "EVENT") return;
    const ev = msg[2];
    if (seen.has(ev.id)) return; // même message reçu via plusieurs relais
    seen.add(ev.id);

    const content = ev.content ?? "";
    const hit = terms.some((t) => content.toLowerCase().includes(t));
    if (!hit) return;

    const time = new Date(ev.created_at * 1000).toLocaleTimeString();
    const nick = tag(ev, "n") || ev.pubkey.slice(0, 8);
    const geohash = tag(ev, "g") || "?";
    console.log(`[${time}] #${geohash} <${nick}> ${content}`);
  });
}
