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
- **Lieu décodé du geohash** (ville la plus proche, hors-ligne — aucun appel à un service de géocodage externe). Sur les cellules très larges (geohash de 1-3 caractères, jusqu'à 5000km de côté), aucune ville n'est affichée — une "proximité" à cette échelle serait trompeuse, juste le niveau de précision (région/zone) est indiqué.
- **Historique interrogeable** : une colonne ajoutée cherche dans toute la base retenue, pas seulement les derniers messages.
- **Clic sur un message** → ouvre `channel.html`, centré et surligné sur ce message, avec tout l'historique du canal autour ; les autres messages du même auteur y sont mis en avant.
- **Clic sur un pseudo** → ouvre `author.html`, tous les messages de cet auteur (identifié par pubkey, pas le pseudo affiché), tous canaux confondus — avec en plus les messages d'autres comptes (pubkeys différentes) ayant affiché le même pseudo, clairement distingués (bordure + avertissement) puisqu'un pseudo bitchat n'est pas une identité vérifiée.
- **Export** (JSON/CSV) d'une recherche (terme + distance + ET/OU).
- **Export/import de toute la base** (fichier `.db`) pour partager l'historique collecté avec quelqu'un d'autre. Import non-destructif (fusion par id, les doublons sont ignorés, rien n'est jamais écrasé) ; la config (colonnes, liste noire) n'est pas incluse — elle vit dans le navigateur, chaque personne garde ses propres règles.
- **Vérification cryptographique** : chaque événement reçu est revérifié (id NIP-01 recalculé, signature schnorr/BIP-340) avant stockage — un événement falsifié ou altéré en transit est rejeté, pas stocké.
- **Liens masqués** dans les messages (`🔗 lien masqué`, révélable au clic, jamais un lien cliquable ni ouvert automatiquement), et un bouton "Flouter" pour flouter tout le contenu jusqu'au survol.
- **Messages "gardés"** (⭐ sur un message) : mis de côté avec une note libre, exclus de la purge automatique, exportables à part — pour constituer un dossier sur un cas précis.
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

Démarre deux conteneurs : `bitchat-backend` (agrégation des relais + API + base SQLite, port `127.0.0.1:8787`) et `bitchat-web` (sert `local.html`/`channel.html`/`author.html`, port `127.0.0.1:8734` — ne monte que ces 3 fichiers, jamais la base). Puis ouvrir **http://localhost:8734/local.html**.

Détails complets (anonymat, variables d'environnement, limites, Tor) : [`backend/README.md`](backend/README.md).

## Cadre légal et éthique

Les messages bitchat observés ici sont publics, mais restent des **données personnelles** :
pseudonymes, contenus, localisation approximative (geohash). Avant tout usage :

- avoir une finalité légitime claire pour cette veille ;
- régler `RETENTION_DAYS` (voir `docker-compose.yml`) au strict nécessaire, et purger plus
  tôt si le besoin disparaît ;
- limiter l'accès à cette instance et à ses exports — le backend n'écoute que sur
  `127.0.0.1`, mais rien n'empêche quelqu'un d'exporter puis de diffuser largement ;
- ne jamais republier de contenu identifiant extrait d'ici sans réflexion préalable ;
- garder en tête que le flux brut, non modéré, peut contenir des contenus choquants ou
  illicites — d'où le masquage des liens et l'option de flou du contenu.

## CLI (`listen.mjs`)

```bash
npm install
node listen.mjs manif police bitcoin
```

Affiche en direct tout message contenant un des termes (sous-chaîne, insensible à la casse). Ne supporte pas la syntaxe ET/OU ni la distance de Levenshtein — pour ça, utiliser le dashboard.
