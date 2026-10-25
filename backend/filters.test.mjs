import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { isNoise, GEOHASH_RE, matches, parseQuery, levenshtein, isValidSignedEvent } from "./filters.mjs";

test("isNoise: pseudo bot_[hex] est du bruit", () => {
  assert.equal(isNoise("salut tout le monde", "bot_faff61fc"), true);
});

test("isNoise: pseudo contenant 'bot' sous une autre forme n'est pas du bruit", () => {
  assert.equal(isNoise("salut", "Nymbot"), false);
  assert.equal(isNoise("salut", "nano_bot#1234"), false);
});

test("isNoise: zalgo (combinants empilés) est du bruit", () => {
  const zalgo = "a" + "́̂̃̄̅".repeat(20);
  assert.equal(isNoise(zalgo, null), true);
});

test("isNoise: accents français normaux ne sont pas du bruit", () => {
  assert.equal(isNoise("rendez-vous à côté de la gare d'Orléans", null), false);
});

test("isNoise: JSON valide est du bruit", () => {
  assert.equal(isNoise('{"type":"handshake","v":1}', null), true);
});

test("isNoise: message de plus de 3000 caractères est du bruit", () => {
  assert.equal(isNoise("a".repeat(3001), null), true);
});

test("isNoise: message normal n'est pas du bruit", () => {
  assert.equal(isNoise("salut ça va ?", "anon1234"), false);
});

test("GEOHASH_RE: geohash valides", () => {
  assert.equal(GEOHASH_RE.test("u0"), true);
  assert.equal(GEOHASH_RE.test("u09t"), true);
  assert.equal(GEOHASH_RE.test("u09tvwxy"), true); // 8 caractères, max officiel (BUILDING)
});

test("GEOHASH_RE: rejette vide, trop long, et hors alphabet", () => {
  assert.equal(GEOHASH_RE.test(""), false);
  assert.equal(GEOHASH_RE.test("u09tvwxyz"), false); // 9 caractères, au-delà du max
  assert.equal(GEOHASH_RE.test("Hello"), false); // majuscule + 'l'/'o' hors alphabet geohash
  assert.equal(GEOHASH_RE.test("u0 9t"), false); // espace
});

test("levenshtein: distance 0 pour chaînes identiques", () => {
  assert.equal(levenshtein("paris", "paris"), 0);
});

test("levenshtein: distance correcte sur une faute de frappe", () => {
  assert.equal(levenshtein("manif", "manfi"), 2);
});

test("matches: distance 0 est une recherche exacte (sous-chaîne)", () => {
  assert.equal(matches("une manifestation à paris", "manif", 0), true);
  assert.equal(matches("rien à voir", "manif", 0), false);
});

test("matches: ET ('+') exige tous les termes du groupe", () => {
  assert.equal(matches("manif prévue à paris demain", "manif+paris", 0), true);
  assert.equal(matches("manif prévue à lyon demain", "manif+paris", 0), false);
});

test("matches: OU (',') accepte n'importe quel groupe", () => {
  assert.equal(matches("rendez-vous bastille", "manif+paris,bastille", 0), true);
  assert.equal(matches("rien à voir", "manif+paris,bastille", 0), false);
});

test("matches: distance > 0 tolère les fautes de frappe", () => {
  // "manig" est à distance 1 de "manif" (une substitution) ; "manfi" (transposition) est
  // en réalité à distance 2 pour Levenshtein standard (pas de coût spécial transposition).
  assert.equal(matches("une manig improvisée", "manif", 1), true);
  assert.equal(matches("une manig improvisée", "manif", 0), false);
});

test("parseQuery: structure groupes ET/OU", () => {
  assert.deepEqual(parseQuery("manif+paris, bastille"), [["manif", "paris"], ["bastille"]]);
});

test("isValidSignedEvent: rejette un id qui ne correspond pas au contenu", () => {
  const ev = {
    id: "0".repeat(64),
    pubkey: "1".repeat(64),
    created_at: 1700000000,
    kind: 20000,
    tags: [["g", "u0"]],
    content: "salut",
    sig: "2".repeat(128),
  };
  assert.equal(isValidSignedEvent(ev), false);
});

test("isValidSignedEvent: accepte un événement réellement signé", () => {
  const privateKey = "1".repeat(63) + "2";
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey));
  const ev = {
    pubkey,
    created_at: 1700000000,
    kind: 20000,
    tags: [["g", "u0"]],
    content: "salut",
  };
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const idHash = sha256(utf8ToBytes(serialized));
  ev.id = bytesToHex(idHash);
  ev.sig = bytesToHex(schnorr.sign(idHash, privateKey));
  assert.equal(isValidSignedEvent(ev), true);
});

test("isValidSignedEvent: rejette un contenu altéré après signature (même id/sig d'origine)", () => {
  const privateKey = "3".repeat(63) + "4";
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey));
  const ev = {
    pubkey,
    created_at: 1700000000,
    kind: 20000,
    tags: [["g", "u0"]],
    content: "message original",
  };
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const idHash = sha256(utf8ToBytes(serialized));
  ev.id = bytesToHex(idHash);
  ev.sig = bytesToHex(schnorr.sign(idHash, privateKey));
  ev.content = "message altéré en transit"; // id/sig ne correspondent plus au contenu
  assert.equal(isValidSignedEvent(ev), false);
});

test("isValidSignedEvent: rejette une signature malformée sans planter", () => {
  const ev = {
    id: "0".repeat(64),
    pubkey: "not-a-valid-pubkey",
    created_at: 1700000000,
    kind: 20000,
    tags: [],
    content: "",
    sig: "not-a-valid-sig",
  };
  assert.equal(isValidSignedEvent(ev), false);
});
