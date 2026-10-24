# bitchat_levenshtein

Filtre en direct les messages publics de [bitchat](https://github.com/permissionlesstech/bitchat) (canaux geohash via Nostr, kind `20000`) par terme, avec tolérance aux fautes de frappe (distance de Levenshtein).

## CLI (`listen.mjs`)

```bash
npm install
node listen.mjs manif police bitcoin
```

Affiche en direct tout message contenant un des termes (sous-chaîne, insensible à la casse).

## Dashboard web (`dashboard.html`)

Fichier statique, sans backend — connexion directe du navigateur aux relais Nostr.

```bash
python3 -m http.server 8000
# puis ouvrir http://localhost:8000/dashboard.html
```

Un terme ajouté = une colonne. La distance réglable (0 = exact, 2-3 = tolère les variantes/fautes de frappe) s'applique en comparant le terme à chaque mot du message.

Déployable tel quel sur GitHub Pages (aucune dépendance, aucune clé).
