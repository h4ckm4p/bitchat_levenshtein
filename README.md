# bitchat_levenshtein

Outil de veille en direct sur [bitchat](https://github.com/permissionlesstech/bitchat) : surveille les canaux geohash publics (Nostr, `kind 20000`) par mot-clé, avec tolérance aux fautes de frappe (distance de Levenshtein) et combinaisons **ET**/**OU**.

Tourne en local via Docker : un backend agrège 330 relais (annuaire officiel bitchat) et garde un historique persistant, le dashboard (`local.html`) s'y connecte.

## Fonctionnalités

- **Colonnes de recherche** (façon TweetDeck) avec distance de Levenshtein réglable par colonne (0 = exact, 1-4 = tolère fautes/variantes).
- **Combinaisons ET / OU** : une petite IHM à 3 champs + un sélecteur permet de composer `manif ET paris` ou `manif OU manifestation OU cortège` sans taper de syntaxe. (En interne : `+` = ET, `,` = OU — ex. `manif+paris, bastille` = *(manif ET paris) OU bastille*.)
- **Liste noire** : mêmes règles de distance/ET/OU, exclut un message de toutes les colonnes.
- **Glisser-déposer** pour réordonner les colonnes, sans perdre leur contenu.
- **Couleur stable par pseudo** et mot surligné dans chaque message, coloré selon la distance de correspondance (bleu = exact → rouge = distance 3+).
- **Badge 📡 "téléporté"** : signale un message posté dans un canal geohash sans y être physiquement (tag officiel bitchat).
- **Lieu décodé du geohash** (ville la plus proche, hors-ligne — aucun appel à un service de géocodage externe).
- **Historique interrogeable** : une colonne ajoutée cherche dans toute la base retenue, pas seulement les derniers messages.
- **Clic sur un message** → ouvre `channel.html`, centré et surligné sur ce message, avec tout l'historique du canal autour.
- **Export** (JSON/CSV) d'une recherche (terme + distance + ET/OU).
- **Nettoyage anti-spam automatique** (voir détail ci-dessous).
- **Purge automatique** après 30 jours (réglable).

### Messages "bruit"

Tout message qui n'est pas du vrai chat humain est stocké (rien n'est supprimé) mais masqué des colonnes, de la recherche et de l'export — un compteur `+N bruit` l'indique dans la barre du dashboard. Détecté automatiquement sur :

- **Pseudos de bot générés aléatoirement** : motif `bot_` + suffixe hexadécimal (ex. `bot_faff61fc`), change à chaque message pour contourner un blocage.
- **Messages énormes** : plus de 3000 caractères — chunks de fichiers/images encodés qui circulent sur les mêmes relais que bitchat.
- **JSON brut** : tout message qui est du JSON valide (ex. `{"type":"handshake",...}`) — trafic protocole d'autres applications partageant les mêmes relais Nostr, pas du chat.
- **Spam "zalgo"** : plus de 30 % de caractères Unicode combinants (accents empilés qui cassent l'affichage).
- **Flood de doublons** : au démarrage puis toutes les 10 minutes, un passage regroupe les messages par canal + contenu identique, et marque bruit tout groupe venant de peu de pseudos différents (≤3, ou un ratio répétitions/pseudos élevé — ex. une pub bitcoin postée 76 fois par 3 comptes). Une réaction courte tapée par coïncidence par plusieurs personnes différentes (ex. ".") n'est pas touchée : seuil minimum de 8 caractères.

Comme le reste du bruit, un doublon détecté est **masqué, pas supprimé** — il reste en base jusqu'à la purge générale (30 jours).

## Démarrage

```bash
cd backend
docker compose up -d --build
```

Démarre deux conteneurs : `bitchat-backend` (agrégation des relais + API + base SQLite, port `127.0.0.1:8787`) et `bitchat-web` (sert `local.html`/`channel.html`, port `127.0.0.1:8734` — ne monte que ces 2 fichiers, jamais la base). Puis ouvrir **http://localhost:8734/local.html**.

Détails complets (anonymat, variables d'environnement, limites, Tor) : [`backend/README.md`](backend/README.md).

## CLI (`listen.mjs`)

```bash
npm install
node listen.mjs manif police bitcoin
```

Affiche en direct tout message contenant un des termes (sous-chaîne, insensible à la casse). Ne supporte pas la syntaxe ET/OU ni la distance de Levenshtein — pour ça, utiliser le dashboard.
