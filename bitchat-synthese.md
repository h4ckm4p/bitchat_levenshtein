# Bitchat — Synthèse

## 1. Qu'est-ce que bitchat
Projet de messagerie **pair-à-pair décentralisée**, lancé par Jack Dorsey (co-fondateur de Twitter, CEO de Block) en juillet 2025. Pas de serveur, pas de compte, pas de numéro de téléphone. Dépôt officiel open source : [permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat) (licence Unlicense / domaine public).

## 2. Architecture technique
Transport **double** :
- **Bluetooth LE mesh (hors-ligne)** : relais multi-hop (max 7 sauts), découverte automatique des pairs, chiffrement de bout en bout via **Noise Protocol** (forward secrecy), protocole binaire optimisé pour BLE, duty-cycling pour économiser la batterie.
- **Nostr (en ligne, depuis v1.3.0)** : relais mondial (440+ relais), portée globale via des **canaux géolocalisés par geohash** (précision réglable : quartier, ville, province, région), chiffrement des messages privés en XChaCha20-Poly1305 (non compatible NIP-17/44/59 standards — extensions propres à bitchat), clés éphémères par zone geohash.
- Messages directs : sélection intelligente du transport (Bluetooth privilégié, bascule Nostr), mise en file d'attente si aucun transport dispo.

## 3. Structure des canaux
- `#bluetooth` : canal mesh local hors-ligne.
- Canaux géographiques (geohash) : du très local (quartier) au mondial, accessibles dès qu'on est en ligne.
- Messages privés (DM) et channels à mot de passe / transfert de propriété.
- Commandes façon IRC : `/join`, `/msg`, `/who`, etc.

## 4. Plateformes officielles
iOS (App Store), macOS (natif), Android (Play Store / GitHub). Projet Swift/Xcode. Aucun client web/CLI officiel.

## 5. Écosystème de clients tiers (non officiels)
| Projet | Type | Remarques |
|---|---|---|
| [bitchat-terminal](https://github.com/Muhammadali0202/bitchat-terminal) | Rust, terminal | Client BLE en ligne de commande |
| [bitchat-tui](https://github.com/vaibhav-mattoo/bitchat-tui) | Rust, TUI | Interface terminal façon IRC, canaux publics/privés/protégés |
| [bitchat-cli](https://github.com/brenorb/bitchat-cli) | Python, CLI | Mesh BLE + canaux Nostr geohash |
| [bitchat-web](https://github.com/ervan0707/bitchat-web) | Node/TS/Vite, Web Bluetooth | Se connecte en vrai BLE depuis le navigateur ; **expérimental**, limité à 1-2 connexions simultanées (contrainte Web Bluetooth), vue mono-canal |
| [bitchat-in-browser](https://github.com/stevemoraco/bitchat-in-browser) | PWA | Interop via Nostr avec les apps natives |
| [bitchat.desktop](https://github.com/pedro-vicente/bitchat.desktop) | Desktop Win/Mac/Linux | Client desktop natif |
| [BitChat Heatmap](https://github.com/Malgsx/Bitchat-Heatmap) | React/Leaflet | Visualise l'activité Nostr/geohash sur une carte + sidebar de canaux, **lecture seule** |
| [BitChat Explorer](https://bitchatexplorer.com/) | Web | Carte mondiale des messages Nostr en temps réel, **lecture seule** |
| [bitchat-world-view](https://github.com/flox1an/bitchat-world-view) | React 19/TS/Vite, Applesauce | Flux unique façon mIRC de tous les canaux geohash publics, **lecture seule**, pas de participation |

## 6. Constat clé : pas d'outil "TweetDeck" existant
Aucun des clients ou viewers trouvés ne propose une interface **multi-colonnes interactive** (plusieurs canaux/geohash/DM affichés et postables en parallèle, à la manière de TweetDeck). Les viewers (Heatmap, Explorer, World View) sont tous **passifs** (une seule liste/carte, lecture seule, pas de compte, pas d'envoi). Les clients qui permettent de participer (terminal, TUI, CLI, bitchat-web) sont tous **mono-vue** (un canal actif à la fois).
→ Il n'existe donc **pas d'équivalent TweetDeck pour bitchat** : c'est un vrai créneau libre.

## 7. Recommandation pour construire l'outil
Partir du côté **Nostr** plutôt que BLE :
- Le BLE mesh (bitchat-web) est bridé par les limites de Web Bluetooth (1-2 connexions, pas de vraie multi-colonne possible côté mesh local).
- Le réseau Nostr (geohash) est, lui, nativement multi-canal, interrogeable via WebSocket depuis un simple client web, et déjà utilisé par bitchat-world-view / BitChat Heatmap comme base technique (React/TS/Vite + lib Nostr type `applesauce` ou `nostr-tools`).
- Piste concrète : une appli web (une colonne = un canal geohash, un DM, ou une recherche/mot-clé), avec abonnement WebSocket par colonne aux relais Nostr publics de bitchat (kind 20000, enveloppes bitchat), + un compte Nostr local (clé privée en local storage) pour pouvoir **poster**, pas seulement lire. On peut réutiliser le code d'abonnement/décodage de `bitchat-world-view` (MIT-friendly, stack proche) comme base plutôt que de repartir de zéro.
- Hors scope si tu veux rester simple : pas de BLE mesh dans la v1 (trop limité côté navigateur), pas de mobile natif.

## Sources
- [permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat)
- [What is Bitchat? – TechTarget](https://www.techtarget.com/whatis/feature/What-is-Bitchat)
- [Jack Dorsey floats bitchat – The Register](https://www.theregister.com/off-prem/2025/07/08/jack-dorsey-floats-bitchat-messaging-app-based-on-bluetooth/672836)
- [bitchat-terminal (Rust)](https://github.com/Muhammadali0202/bitchat-terminal)
- [bitchat-tui](https://github.com/vaibhav-mattoo/bitchat-tui)
- [bitchat-cli (Python)](https://github.com/brenorb/bitchat-cli)
- [bitchat-web](https://github.com/ervan0707/bitchat-web)
- [bitchat-in-browser](https://github.com/stevemoraco/bitchat-in-browser)
- [bitchat.desktop](https://github.com/pedro-vicente/bitchat.desktop)
- [Bitchat-Heatmap](https://github.com/Malgsx/Bitchat-Heatmap)
- [BitChat Explorer](https://bitchatexplorer.com/)
- [bitchat-world-view](https://github.com/flox1an/bitchat-world-view)
