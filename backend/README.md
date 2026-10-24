# Backend local (Docker)

Agrège les relais bitchat (Nostr geohash) **une seule fois** côté serveur au lieu que
chaque navigateur ouvre ses propres connexions, garde un **historique persistant** (SQLite —
les events bitchat sont éphémères côté relais, rien n'est stocké sans ça), et filtre déjà
le bruit protocole (`nearby-presence`/`handshake` d'autres apps) avant de servir les données.

Pensé pour tourner **en local uniquement** — pas un service à exposer publiquement.

## Démarrer

```bash
cd backend
docker compose up -d --build
```

Vérifier que ça tourne :
```bash
curl http://127.0.0.1:8787/health
docker compose logs -f
```

Puis ouvrir `../local.html` (servi en statique, ex: `python3 -m http.server 8000` depuis le
dossier parent `listener/`, puis `http://localhost:8000/local.html`). C'est la même
interface que le dashboard GitHub Pages (`index.html`), mais elle se connecte à ce backend
local au lieu des relais directement — avec en plus l'historique au chargement.

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
  et relance (`docker compose up -d`). Sans ça, les opérateurs des ~10 relais voient ton IP
  réelle se connecter en continu — ce qui est un signal "quelqu'un surveille ce flux en
  permanence depuis cette IP", pas anodin si l'anonymat compte pour toi.
- **Pas de compte, pas de clé** : on ne fait que *lire* les relais (`REQ`), jamais publier —
  donc aucune identité Nostr n'est créée ni exposée.
- **Liste d'origines autorisées** : le backend refuse les requêtes dont l'en-tête `Origin` ne
  fait pas partie de `ALLOWED_ORIGINS` (par défaut : le dashboard GitHub Pages + localhost) —
  un site tiers ne peut pas faire parler ton backend local depuis le navigateur d'un visiteur.

## Limites

- Ne tourne que quand le conteneur tourne — pas un vrai "24/7" sauf si tu laisses ta machine
  allumée en continu.
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
| `ALLOWED_ORIGINS` | GitHub Pages + localhost | Origines autorisées à parler au backend |
| `TOR_PROXY` | (vide) | Proxy SOCKS5 pour les connexions sortantes aux relais, ex `socks5h://host.docker.internal:9050` |
