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
   - ⏩ **Silences ×100** : détecte les blancs (seuil/durée réglables), les
     accélère jusqu'à 100× (gain de temps, avec prévisualisation des zones).
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
6. **Timeline** : glisse-dépose des fichiers (image, vidéo, audio) directement
   sur les pistes, rogne par les poignées, ✂️ coupe un clip au niveau de la tête
   de lecture, ⤢ étends un clip jusqu'au suivant. Pistes audio multiples pour
   musique/bruitages (volume, fondus, boucle).
7. **💬 Sous-titres** : incrustation du texte (police, taille, couleurs, contour,
   position, animation, mode karaoké) avec aperçu live dans la scène.
8. **🎬 Exporter** : format (16:9, 720p, vertical, carré), cadence, qualité,
   normalisation EBU R128, sous-titres incrustés ou non → MP4 dans
   `data/projects/<projet>/build/`.

## Raccourcis

| Touche | Action |
| --- | --- |
| `Espace` | Lecture / pause |
| `←` `→` | Reculer / avancer de 1 s (`Maj` = 5 s) |
| `C` | Couper (clip sélectionné, sinon sélection de la voix) |
| `S` / `D` / `T` | Panneaux Silences / Débruitage / Transcription |
| `Suppr` | Supprimer le clip sélectionné |
| `+` / `-` | Zoom de la timeline (`Ctrl` + molette aussi) |

## Où sont les fichiers

```
data/
  projects/<id>/
    project.json     # montage (non destructif: coupes, clips, effets)
    media/           # sources importées + illustrations téléchargées
    build/           # voix compilée, sous-titres.ass, rendus MP4
  models/            # modèles Whisper (ggml-*.bin) + RNNoise (.rnnn)
  tools/whisper/     # binaire whisper.cpp
  cache/img/         # vignettes des recherches d'images
```

Le montage est **non destructif** : les fichiers d'origine ne sont jamais
modifiés, seule la compilation (`build/`) applique les traitements.

## Notes

- Les images web proviennent du scraping de Bing Images (repli DuckDuckGo), plus
  Openverse (Creative Commons) et Wikimedia Commons. Vérifie les licences si tu
  publies le montage.
- La transcription se fait sur la voix **après** nettoyage : si tu changes les
  coupes après coup, relance la transcription pour recaler les mots.
