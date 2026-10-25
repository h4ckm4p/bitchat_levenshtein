# Backend local (Docker)

Agrège les relais bitchat (Nostr geohash) **une seule fois** côté serveur au lieu que
chaque navigateur ouvre ses propres connexions, garde un **historique persistant** (SQLite —
les events bitchat sont éphémères côté relais, rien n'est stocké sans ça), et filtre déjà
le bruit protocole (`nearby-presence`/`handshake` d'autres apps) avant de servir les données.

**Filtre à la source** : le kind Nostr `20000` utilisé par bitchat n'est pas réservé à
bitchat — c'est la plage "éphémère" générique de NIP-01 (`20000<=kind<30000`), confirmé
dans le code officiel (`NostrProtocol.kt`, commentaire *"ephemeral public message (kind
20000)"*), que n'importe quelle appli Nostr peut réutiliser. Sans tag `g` (geohash) valide
(alphabet base32 standard, 1-8 caractères — cf. `GeohashChannelLevel` du client Android),
un événement n'est pas un message bitchat et n'est **pas stocké du tout** (`filters.mjs`,
`GEOHASH_RE`) — ça écartait avant ce correctif près de 50% du volume ingéré (trafic d'autres
applis partageant le même kind, ou tag `g` en texte libre).

Pensé pour tourner **en local uniquement** — pas un service à exposer publiquement.

## Démarrer

```bash
cd backend
docker compose up -d --build
```

`docker compose up -d` démarre **deux** conteneurs : `bitchat-backend` (agrégation + API,
port 8787) et `bitchat-web` (sert les pages statiques `local.html`/`channel.html`/`author.html`,
port 8734 — ne monte que ces 3 fichiers, pas tout le dossier `backend/` qui contient la base
SQLite).

Vérifier que ça tourne :
```bash
curl http://127.0.0.1:8787/health
docker compose logs -f
```

Puis ouvrir **http://localhost:8734/local.html**. Cliquer un message ouvre `channel.html`,
l'historique complet + le direct de ce canal.

## Anonymat

- **Jamais exposé au réseau** : `docker-compose.yml` publie le port en `127.0.0.1:8787:...`
  (pas `8787:...` tout court) — inaccessible depuis le réseau local ou internet, même par
  erreur de configuration du pare-feu.
- **Sortie via Tor (optionnel)** : bitchat lui-même route son trafic Nostr "over Tor where
  enabled" selon son whitepaper officiel. Pour faire pareil : installe et lance Tor sur ta
  machine (port SOCKS 9050 par défaut), puis dans `docker-compose.yml` décommente :
  ```yaml
  - TOR_PROXY=socks5h://host.docker.internal:9050
  ```
  et relance (`docker compose up -d`). Sans ça, les opérateurs des ~330 relais (annuaire
  officiel bitchat, voir `relays.json`) voient ton IP réelle se connecter en continu — ce
  qui est un signal "quelqu'un surveille ce flux en permanence depuis cette IP", pas anodin
  si l'anonymat compte pour toi.
- **Pas de compte, pas de clé** : on ne fait que *lire* les relais (`REQ`), jamais publier —
  donc aucune identité Nostr n'est créée ni exposée.
- **Liste d'origines autorisées** : le backend refuse les requêtes dont l'en-tête `Origin` ne
  fait pas partie de `ALLOWED_ORIGINS` (par défaut : localhost uniquement) — un site tiers ne
  peut pas faire parler ton backend local depuis le navigateur d'un visiteur.

## Limites

- Ne tourne que quand le conteneur tourne — pas un vrai "24/7" sauf si tu laisses ta machine
  allumée en continu.
- **Après avoir modifié `local.html`/`channel.html`/`author.html`** (si tu code toi-même) :
  `docker compose restart bitchat-web`. Le montage du fichier en lecture seule peut rester
  bloqué sur une vue périmée du fichier (tronquée) après plusieurs écritures rapides sur
  macOS/Docker Desktop — observé en conditions réelles (page qui ne faisait plus rien du
  tout, sans erreur visible). Un simple redémarrage du conteneur suffit.
- Utilisable uniquement depuis cette machine (le navigateur doit être sur le même poste que
  Docker) — pas partageable à distance en l'état.
- Le proxy Tor n'a pas été testé en conditions réelles ici (pas de démon Tor disponible
  pendant le développement) — le code path existe et n'a pas d'effet si `TOR_PROXY` n'est
  pas défini, mais vérifie toi-même que la connexion sort bien par Tor avant de t'y fier
  (ex: compare l'IP vue par un relais avec/sans la variable activée).

## Variables d'environnement (`docker-compose.yml`)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8787` | Port HTTP/WS du backend |
| `DB_PATH` | `./data/bitchat.db` | Fichier SQLite (monté en volume, persiste entre redémarrages) |
| `ALLOWED_ORIGINS` | localhost | Origines autorisées à parler au backend |
| `TOR_PROXY` | (vide) | Proxy SOCKS5 pour les connexions sortantes aux relais, ex `socks5h://host.docker.internal:9050` |
| `RETENTION_DAYS` | `30` | Purge automatique (toutes les heures) des messages plus vieux que N jours |

## Vérification cryptographique et tests

Chaque événement reçu d'un relais est revérifié avant stockage (`filters.mjs`,
`isValidSignedEvent`) : l'id NIP-01 est recalculé et la signature schnorr (BIP-340, via
`@noble/curves`) est vérifiée. Un événement dont l'id ou la signature ne correspond pas est
rejeté silencieusement (compteur `invalidSignatureCount` exposé dans `GET /api/status`).

Les fonctions pures (filtre de bruit, filtre geohash, recherche ET/OU, vérification de
signature) vivent dans `backend/filters.mjs`, testées isolément (`node:test`, aucun accès
réseau/DB) :

```sh
npm test
```

Endpoints "messages gardés" (⭐, voir README racine) : `POST /api/keep` (`{id, note}`),
`POST /api/unkeep` (`{id}`), `GET /api/kept`, `GET /api/export/kept?format=json|csv`.

## Partager la base avec quelqu'un d'autre

`GET /api/db/export` renvoie un instantané cohérent de toute la base (`VACUUM INTO` — fusionne
le WAL, pas de risque de copier une écriture à moitié faite), accessible directement depuis
le bouton "⬇ Exporter toute la base" du dashboard. `POST /api/db/import` (bouton "⬆ Importer
une base") fusionne un fichier `.db` reçu : `INSERT OR IGNORE` sur l'id, donc **non-destructif**
— ça n'ajoute que les messages absents de ta base actuelle, n'écrase et ne supprime jamais
rien. La config (colonnes, liste noire) n'est pas incluse, elle vit dans le navigateur de
chacun.
