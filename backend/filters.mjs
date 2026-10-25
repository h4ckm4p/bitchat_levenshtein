// Fonctions pures (pas de DB, pas de réseau) extraites de server.mjs pour être testables
// isolément (node --test) -- importer server.mjs directement déclencherait la connexion
// aux 330 relais et l'ouverture de la base au chargement du module.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";

export const MAX_LEN = 3000;
// plages Unicode des diacritiques combinants utilisées par le spam "zalgo" (écrites en
// \uXXXX plutôt qu'en caractères bruts -- des combinants littéraux dans le code source
// s'afficheraient collés au caractère précédent, illisibles à relire/vérifier).
export const COMBINING_RE = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
// pseudo généré automatiquement par un bot de spam observé en direct : "bot_" suivi
// d'un suffixe hexadécimal aléatoire (ex: bot_faff61fc) -- change à chaque message pour
// contourner un blocage par pseudo, donnant l'impression trompeuse que "le pseudo change
// sans arrêt" alors que c'est le même spam répété. Motif très spécifique : vérifié sur la
// base réelle, aucun faux positif parmi les pseudos légitimes contenant "bot" (Nymbot,
// infobot, AntiSpamBot, nano_bot#..., etc. ont tous un format différent).
export const BOT_NICK_RE = /^bot_[0-9a-f]{6,8}$/;
// kind 20000 n'est pas réservé à bitchat (c'est le type "éphémère" générique Nostr, NIP-01
// : 20000<=kind<30000 -- confirmé sur la spec officielle) -- d'autres applis l'utilisent
// pour leur propre protocole, parfois avec un tag "g" qui n'est pas un geohash (nom de
// canal, texte libre). Alphabet geohash standard (base32, sans a/i/l/o) ; longueur max 8,
// d'après l'enum officiel GeohashChannelLevel du client Android (REGION=2, PROVINCE=4,
// CITY=5, NEIGHBORHOOD=6, BLOCK=7, BUILDING=8 -- aucune précision au-delà n'existe côté
// client) -- sert à écarter ce trafic hors-sujet avant stockage, cf. analyse live.
export const GEOHASH_RE = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,8}$/;

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}
// syntaxe de recherche, cohérente avec le dashboard (local.html) : virgule = OU, "+" = ET
// -- ex: "manif+paris, bastille" matche (manif ET paris) OU bastille.
export function parseQuery(term) {
  return term.split(",")
    .map((group) => group.split("+").map((s) => s.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
}
export function matchesOne(content, term, dist) {
  const text = (content || "").toLowerCase();
  const t = term.toLowerCase();
  if (dist <= 0) return text.includes(t);
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => levenshtein(w, t) <= dist);
}
export function matches(content, term, dist) {
  return parseQuery(term).some((group) => group.every((t) => matchesOne(content, t, dist)));
}

// un message de chat humain n'est quasiment jamais du JSON valide, peu importe sa forme
// (handshake/nearby-presence avaient un champ "type", mais les chunks d'image base64
// ("v","ts","n","frame") n'en ont pas -- donc on ne teste plus un champ précis, juste
// la validité JSON globale).
// Détecte aussi deux abus observés en direct : des messages énormes (ex: 300 Ko) et le
// spam "zalgo" (empilement de caractères Unicode combinants pour casser l'affichage).
export function isNoise(content, nickname) {
  if (nickname && BOT_NICK_RE.test(nickname)) return true;
  const text = (content || "").trim();
  if (text.length > MAX_LEN) return true;
  if (text.startsWith("{") || text.startsWith("[")) {
    try { JSON.parse(text); return true; } catch { /* pas du JSON, continue */ }
  }
  const combining = (text.match(COMBINING_RE) || []).length;
  return text.length > 0 && combining / text.length > 0.3;
}

// Recalcule l'id NIP-01 (sha256 de la sérialisation canonique) et vérifie la signature
// schnorr (BIP-340) -- rejette un événement falsifié ou altéré en transit avant stockage,
// donne une vraie valeur probante aux exports. Pas d'exception : toute anomalie (champ
// manquant, pubkey/sig malformés...) renvoie simplement false plutôt que de faire planter
// l'ingestion sur un événement mal formé.
export function isValidSignedEvent(ev) {
  try {
    const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
    const idHash = sha256(utf8ToBytes(serialized));
    const idHex = Buffer.from(idHash).toString("hex");
    if (idHex !== ev.id) return false;
    return schnorr.verify(ev.sig, idHash, ev.pubkey);
  } catch {
    return false;
  }
}
