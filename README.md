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
6. **🗂️ Médiathèque** : tous les médias du projet (images, vidéos, sons) avec
   leur vignette, leur durée/format et le nombre de fois où ils servent. Dépose
   des fichiers dans le panneau pour les importer, glisse un média sur une piste
   de la timeline pour le poser à l'endroit voulu, double-clic (ou 👁) pour
   l'aperçu complet, ＋ pour l'ajouter à la tête de lecture, ✕ pour le retirer.
7. **Timeline** : glisse-dépose des fichiers (image, vidéo, audio) directement
   sur les pistes, rogne par les poignées, ✂️ coupe un clip au niveau de la tête
   de lecture, ⤢ étends un clip jusqu'au suivant, `Ctrl`/`Maj` + clic pour
   sélectionner plusieurs morceaux et `Suppr` pour les retirer d'un coup. Pistes
   audio multiples pour musique/bruitages (volume, fondus, boucle).
8. **💬 Sous-titres** : incrustation du texte (police, taille, couleurs, contour,
   position, animation, mode karaoké) avec aperçu live dans la scène.
9. **🎬 Exporter** : format (16:9, 720p, vertical, carré), cadence, qualité,
   normalisation EBU R128, sous-titres incrustés ou non → MP4 dans
   `data/projects/<projet>/build/`.

Les exports sont **incrémentaux** : chaque clip est préparé une fois (recadrage,
zoom, Ken Burns) et mis en cache dans `build/cache/`, donc un second export après
quelques retouches est environ deux fois plus rapide. Le cache se purge seul au
bout de trois semaines.

## Sécurité du travail

- **Ctrl+Z / Ctrl+Shift+Z** (ou les boutons ↶ ↷ de la barre) annulent et
  rétablissent les modifications : clips, pistes audio, sous-titres,
  transcription et réglages voix. L'historique couvre les 40 dernières actions.
- L'enregistrement du projet est **atomique** : le fichier est écrit à côté puis
  renommé, et la version précédente est conservée en `project.json.bak`. Un arrêt
  brutal ne peut donc pas laisser un projet tronqué.
- Les projets sont sauvegardables en un fichier : bouton **💾** dans la fenêtre
  🗂️ Projets (nom du projet en haut à gauche) → archive `.tar.gz` contenant le
  montage, les médias et la voix compilée. **📥 Restaurer une sauvegarde** la
  réimporte dans un nouveau projet, prête à être exportée.

## Raccourcis

| Touche | Action |
| --- | --- |
| `Espace` | Lecture / pause |
| `←` `→` | Reculer / avancer de 1 s (`Maj` = 5 s) |
| `C` | Couper (clip sélectionné, sinon sélection de la voix) |
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
    build/           # voix compilée, sous-titres.ass, rendus MP4
    build/cache/     # clips pré-rendus réutilisés d'un export à l'autre
  models/            # modèles Whisper (ggml-*.bin) + RNNoise (.rnnn)
  tools/whisper/     # binaire whisper.cpp
  cache/img/         # vignettes des recherches d'images
  fonts/subtitles.ass # sous-titres en cours de rendu (libass)
  fonts/ttf/         # polices Google en TTF statiques (une graisse = un fichier)
```

Le montage est **non destructif** : les fichiers d'origine ne sont jamais
modifiés, seule la compilation (`build/`) applique les traitements.

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
- Le code est versionné par git ; les données locales (`data/`, médias, modèles)
  sont volontairement ignorées du dépôt (volumineuses).
