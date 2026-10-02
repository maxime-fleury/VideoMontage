# 🎬 Montage Video

Outil de montage vidéo local : tu enregistres ta voix, tu la nettoies, tu la fais
transcrire par Whisper, puis tu illustres chaque mot-clé par des images trouvées
sur le web. Le rendu final est un MP4 (H.264/AAC) produit par FFmpeg.

Tout tourne en local : serveur Bun + interface navigateur, FFmpeg et whisper.cpp
sur ta machine. Rien n'est envoyé dans le cloud (sauf les recherches d'images).

## Lancer

```bash
bun run dev      # ou: bun run src/index.ts
```

Puis ouvre <http://localhost:3000> (le port part de 3000 et cherche un port libre
jusqu'à 3600).

Pré-requis : `ffmpeg` + `ffprobe` dans le PATH (déjà installés chez toi).
Whisper s'installe depuis l'app (bouton ⚙️ ou ⬇️ dans le panneau latéral).

## Le flux de travail

0. **🧩 Panneaux** : le bouton en haut ouvre un menu à cases à cocher pour
   afficher/masquer chaque panneau (Aperçu, Voix, Timeline, Transcription,
   Montage automatique, Médiathèque, Outils) et gérer les pistes. Les panneaux
   visibles se partagent la hauteur ; la poignée horizontale entre deux panneaux
   fixe une hauteur précise. Masquer ou replier ne laisse jamais de vide : la
   colonne sans panneau visible disparaît et les autres se partagent toute la
   largeur au prorata (et se réduisent si tu rétrécis la fenêtre).
1. **🎙️ Enregistrer** ou **📁 Importer** un audio → il devient la piste voix.
2. **Nettoyer** :
   - ✂️ **Couper** : sélectionne une zone sur la forme d'onde, clique (ou `C`).
   - ⏩ **Silences ×100** : *Seuil auto* mesure ton plancher de bruit et choisit
     le seuil tout seul (bien plus fiable qu'un −35 dB fixe), **Analyser**
     prévisualise les zones en jaune sur la forme d'onde avec le temps gagné,
     puis **Appliquer** accélère les silences jusqu'à 100×. Décoche « Seuil auto »
     pour le régler à la main.
   - 🔊 **Débruitage** : *profil sur un blanc* (sélectionne 0,5 s de silence →
     analyse du bruit de fond → soustraction type Audacity), *auto* (adaptatif)
     ou *RNNoise* (IA, modèle à télécharger dans ⚙️).
3. **🗣️ Transcrire** (Whisper, français) : chaque mot est timecodé et cliquable.
4. **Illustrer** :
   - clic sur un mot → propositions d'images (web, Openverse, Wikimedia) →
     clic sur une image = ajout (ou remplacement du clip au même endroit) ;
   - **🪄 Montage auto** : l'outil repère les mots **illustrables** (noms concrets,
     thèmes récurrents, paires nom + adjectif), te montre la liste **avant**
     génération — tu peux corriger, remplacer ou retirer chaque mot-clé — puis
     remplit la timeline avec transitions et zoom lent.
5. **Transitions & fondus** : par clip (Coupe franche, Fondu au noir, Fondu
   enchaîné, Glissements, Zoom), plus fondu d'entrée/sortie et Ken Burns.
6. **🎞️ Superpositions (incrustations)** : « + Piste vidéo » (ou `V`) ajoute un
   calque au-dessus de la piste principale — jusqu'à trois. Glisse une image ou
   une vidéo dessus, puis double-clic sur l'incrustation pour la régler :
   **agencements prêts** (plein cadre, moitié gauche/droite, PiP dans chaque coin,
   bandeaux, vignette centrale) et **mouvements prédéfinis** (PiP qui entre,
   dérives ←→↑↓, zoom avant/arrière, pop, entrées glissées) avec curseur
   d'intensité, opacité, rotation, cadrage (remplir/entier) et fondus. Les
   incrustations se voient en direct dans l'aperçu (bouton 👁 pour les couper si
   la lecture saccade) et sont rendues par ffmpeg avec **les mêmes formules**.
7. **📝 Textes libres** : « + Texte » (ou `X`) crée un texte indépendant de la
   voix. Glisse-le, redimensionne-le et tourne-le **directement à la souris sur
   l'aperçu** (poignées sur le texte sélectionné, aimants du centre et des bords,
   `Alt` pour désactiver) ; l'éditeur règle police (les 11 familles locales),
   taille, gras/italique, couleurs, surlignage, contour, ombre, pastille de fond,
   interlignage, alignement, rotation et animations d'entrée/sortie (fondu, pop,
   glissement, **machine à écrire**, **surlignage mot par mot**).
8. **🗂️ Médiathèque** : tous les médias du projet (images, vidéos, sons) avec
   leur vignette, leur durée/format et le nombre de fois où ils servent. Dépose
   des fichiers dans le panneau pour les importer, glisse un média sur une piste
   de la timeline pour le poser à l'endroit voulu, double-clic (ou 👁) pour
   l'aperçu complet, ＋ pour l'ajouter à la tête de lecture, ✕ pour le retirer.
9. **Timeline** : glisse-dépose des fichiers (image, vidéo, audio) directement
   sur les pistes, rogne par les poignées, ✂️ coupe un clip au niveau de la tête
   de lecture, ⤢ étends un clip jusqu'au suivant, `Ctrl`/`Maj` + clic pour
   sélectionner plusieurs morceaux et `Suppr` pour les retirer d'un coup. Pistes
   audio multiples pour musique/bruitages (volume, fondus, boucle).
10. **💬 Sous-titres** : incrustation du texte (police, taille, couleurs, contour,
   position, animation, mode karaoké) avec aperçu live dans la scène.
11. **🤖 Montage automatique complet** (panneau à droite, ou « Montage complet »
    dans la barre de la voix) : une seule tâche enchaîne **silences →
    transcription → mots-clés → illustrations → sous-titres → export**. Elle
    s'arrête à trois **points de contrôle** : validation des silences (avec
    possibilité d'ajuster seuil, facteur et durée mini — la voix est alors
    réanalysée), validation de la liste des mots-clés illustrables, puis
    récapitulatif avant l'export. Le projet est enregistré après chaque étape et
    les réglages ainsi que le journal restent visibles ensuite.
12. **🎬 Exporter** : format (16:9, 720p, vertical, carré), cadence, qualité,
   normalisation EBU R128, sous-titres incrustés ou non → MP4 dans
   `data/projects/<projet>/build/`.

Les exports sont **incrémentaux** : chaque clip est préparé une fois (recadrage,
zoom, Ken Burns) et mis en cache dans `build/cache/`, donc un second export après
quelques retouches est environ deux fois plus rapide. Le cache se purge seul au
bout de trois semaines.

## Sécurité du travail

- **Ctrl+Z / Ctrl+Shift+Z** (ou les boutons ↶ ↷ de la barre) annulent et
  rétablissent les modifications : clips, pistes audio **et vidéo**, textes
  libres, sous-titres, transcription et réglages voix. L'historique couvre les 40
  dernières actions.
- L'enregistrement du projet est **atomique** : le fichier est écrit à côté puis
  renommé, et la version précédente est conservée en `project.json.bak`. Un arrêt
  brutal ne peut donc pas laisser un projet tronqué.
- Les projets sont sauvegardables en un fichier : bouton **💾** dans la fenêtre
  🗂️ Projets (nom du projet en haut à gauche) → archive `.tar.gz` contenant le
  montage, les médias et la voix compilée. **📥 Restaurer une sauvegarde** la
  réimporte dans un nouveau projet, prête à être exportée.
- **Tout est interruptible** : le bouton **✕** de la barre du haut (et les boutons
  « ⏹ Annuler » dans la fenêtre d'export, dans le montage automatique et dans les
  générations d'images) **tue vraiment les processus** ffmpeg/whisper en cours.
  Un rendu interrompu laisse supprimer son fichier partiel, et le projet garde ce
  qui avait déjà été sauvegardé. Un seul travail lourd tourne à la fois : si tu
  lances un export pendant une transcription, le second attend son tour et reste
  annulable.
- Une annulation pendant le **montage complet** arrête proprement à l'étape en
  cours : le panneau 🤖 propose **↻ Reprendre**, et recharger la page retrouve le
  montage en attente pour le continuer ou l'annuler.
- Les **3 pistes de superposition maximum** sont vérifiées côté serveur : même un
  appel direct à l'API est refusé au-delà (`Maximum 3 pistes de superposition`).

## Raccourcis

| Touche | Action |
| --- | --- |
| `Espace` | Lecture / pause |
| `←` `→` | Reculer / avancer de 1 s (`Maj` = 5 s) |
| `C` | Couper (clip sélectionné, sinon sélection de la voix) |
| `V` | Ajouter une piste vidéo (superpositions) |
| `X` | Ajouter un texte libre au niveau de la tête de lecture |
| `S` / `D` / `T` | Panneaux Silences / Débruitage / Transcription |
| `Suppr` | Supprimer la sélection (plusieurs clips possibles) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Annuler / rétablir |
| `+` / `-` | Zoom de la timeline (`Ctrl` + molette aussi) |

## Où sont les fichiers

```
data/
  projects/<id>/
    project.json     # montage (non destructif: coupes, clips, effets)
    project.json.bak # version précédente, en secours
    media/           # sources importées + illustrations téléchargées
    build/           # voix compilée, sous-titres.ass, texts.ass, rendus MP4
    build/cache/     # clips pré-rendus réutilisés d'un export à l'autre
  models/            # modèles Whisper (ggml-*.bin) + RNNoise (.rnnn)
  tools/whisper/     # binaire whisper.cpp
  cache/img/         # vignettes des recherches d'images
  fonts/subtitles.ass # sous-titres en cours de rendu (libass)
  fonts/texts.ass     # textes libres en cours de rendu (libass)
  fonts/ttf/         # polices Google en TTF statiques (une graisse = un fichier)
```

Le montage est **non destructif** : les fichiers d'origine ne sont jamais
modifiés, seule la compilation (`build/`) applique les traitements.

## Vérifier le code

```bash
bun test                                     # tests unitaires (aucune dépendance externe)
bun build src/index.ts --target=bun          # vérifie que le serveur compile
bun build public/js/app.js --target=browser  # vérifie que le front compile
```

Les tests couvrent les **mouvements prédéfinis des incrustations** (les formules
utilisées par ffmpeg et par l'aperçu doivent donner exactement les mêmes nombres),
la génération des **textes libres** en ASS (échappement, timing, machine à écrire,
surlignage), les **segments de la voix** (coupes et accélérations) et les
**points de contrôle** du montage automatique.

Ils couvrent aussi **le front** (les modules de `public/js` sont testés tels
qu'ils sont servis au navigateur) :

- géométrie de l'aperçu (centre stable, dérives, fondus, gabarit inconnu) ;
- largeurs de colonnes (proportionnelles : masquer un panneau ne laisse pas de vide) ;
- fusion d'identité des projets (`adoptProject` : un objet connu garde son identité) ;
- moteur de mots-clés (élisions, noms concrets retenus, verbes et adverbes écartés) ;
- annulation (un processus est bien tué, un seul travail lourd à la fois, une
  tâche qui attend son tour ne démarre jamais) ;
- serveur + front ensemble : la page, tous les modules importés, la limite de
  3 pistes vidéo et les routes de projet sont vérifiés sur un serveur de test
  isolé (`data/` temporaire, jamais le vrai dossier de projets).

## Notes

- Les images web proviennent du scraping de Bing Images (repli DuckDuckGo), plus
  Openverse (Creative Commons) et Wikimedia Commons. Vérifie les licences si tu
  publies le montage.
- La transcription se fait sur la voix **après** nettoyage : si tu changes les
  coupes après coup, relance la transcription pour recaler les mots.
- Les polices doivent être des TTF **statiques** : les fichiers variables de
  Google Fonts (`Outfit[wght].ttf`) sont ignorés silencieusement par libass, qui
  retombe alors sur Arial. L'app télécharge donc un fichier par graisse dans
  `data/fonts/ttf/`.
- Les incrustations et les textes sont décrits en **fractions du cadre** (0 à 1)
  de la sortie : ce que tu déplaces dans l'aperçu est exactement ce qui est
  exporté, quelle que soit la résolution choisie. Les mouvements vivent dans
  `src/lib/motions.ts` (une seule définition, utilisée par ffmpeg et par
  l'aperçu via `public/js/expr.js`).
- Le code est versionné par git ; les données locales (`data/`, médias, modèles)
  sont volontairement ignorées du dépôt (volumineuses).
- Le serveur est découpé en modules : `src/routes/` (jobs, système, projets, voix,
  illustrations, montage automatique) et `src/lib/` (validation, mots-clés,
  sérialisation, tâches). `src/index.ts` ne fait plus que le routage.
- Pour tester avec d'autres dossiers : `MONTAGE_DATA_DIR=/tmp/montage` (données à
  part) et `MONTAGE_PORT=39000` (port de départ).
