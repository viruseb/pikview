# Pikview

Application web (PWA) d'une seule page qui **photographie une grille de
nonogramme (picross), la lit, la résout et affiche la solution en
superposition sur la photo**.

Tout se passe dans le navigateur du téléphone : aucune image n'est envoyée
sur un serveur.

## Utilisation

1. Ouvrez le site, autorisez l'accès à la caméra.
2. Cadrez la grille entière (indices du haut **et** de gauche compris), bien à
   plat, puis déclenchez. Vous pouvez aussi choisir une photo existante via
   **Galerie**.
3. L'application détecte le quadrillage, sépare les blocs d'indices et lit les
   chiffres.
4. **Vérifiez et corrigez les indices** dans l'éditeur — la reconnaissance
   automatique se trompe régulièrement. L'indicateur de somme
   (lignes = colonnes) signale immédiatement une erreur restante.
5. Appuyez sur **Résoudre**. La solution s'affiche par-dessus la photo ; les
   quatre coins sont ajustables au doigt si le calage n'est pas parfait.

Si les indices ne se tiennent pas — il suffit d'un « 1 » lu « 7 » — l'application
ne refuse pas : elle écarte les lignes fautives et reconstruit ce qui reste
démontrable. Un nonogramme est très surdéterminé (soixante contraintes pour
huit cent soixante-quinze cases sur une grille de 25 × 35), si bien qu'une ou
deux lignes perdues laissent le plus souvent l'image entière déductible. Les
cases qu'aucune contrainte ne tranche restent grises plutôt que devinées, et
l'application prévient quand il a fallu écarter tant d'indices que l'image
n'est probablement plus celle de la grille.

Le bouton **Saisie manuelle** permet d'entrer une grille sans photo — utile si
la photo est trop abîmée, et parfaitement hors ligne.

## Ce qu'il faut en attendre

La détection du quadrillage est fiable, y compris sur une page bombée ou
photographiée de travers : chaque trait est suivi en polyligne à travers
l'image, si bien que la superposition tombe pile sur les cases.

La **lecture des chiffres**, elle, se trompe. Sur la photo de test (grille
20 × 30, 50 lignes d'indices), 48 lignes sur 50 sont lues exactement ; les
deux erreurs sont des « 1 » pris pour des « 4 ». C'est pour cela que
l'éditeur d'indices est au centre de l'application plutôt qu'en option : le
contrôle de somme (lignes = colonnes) signale immédiatement qu'il reste une
erreur, et les lignes dont la reconnaissance a hésité sont surlignées. Une
grille qui se résout de plusieurs façons trahit presque toujours, elle aussi,
une erreur de lecture — l'application le dit.

## Installation

Depuis le navigateur du téléphone : « Ajouter à l'écran d'accueil » (ou le
bouton **Installer** sur Android). L'application fonctionne ensuite hors ligne,
à une exception près : le moteur de reconnaissance de caractères
(Tesseract.js et ses données, environ 6 Mo) est téléchargé au premier usage de
l'analyse d'image, puis mis en cache.

### Héberger soi-même le moteur OCR

Pour supprimer toute dépendance à un CDN — et rendre l'application utilisable
hors ligne dès le premier lancement — déposez les fichiers de Tesseract.js
dans un dossier du site et ouvrez la page avec `?ocr=chemin/du/dossier`. Le
dossier doit contenir :

```
tesseract.min.js                     (tesseract.js@5 /dist)
worker.min.js                        (tesseract.js@5 /dist)
core/tesseract-core-simd-lstm.wasm.js   (tesseract.js-core@5)
core/tesseract-core-lstm.wasm.js        (idem, repli sans SIMD)
lang/eng.traineddata.gz              (jeu « 4.0.0_fast », ~2 Mo)
```

Le moteur tourne en mode LSTM : ce sont bien les variantes `-lstm` qui sont
demandées, pas les fichiers `tesseract-core.wasm.js` complets.

## Fonctionnement

| Fichier | Rôle |
| --- | --- |
| `js/camera.js` | accès `getUserMedia`, bascule d'objectif, lampe |
| `js/vision.js` | redressement, seuillage adaptatif, détection du quadrillage, découpage des blocs d'indices |
| `js/ocr.js` | reconnaissance des chiffres (Tesseract.js, chargé à la demande) |
| `js/solver.js` | solveur exact : propagation de contraintes ligne par ligne + retour arrière |
| `js/solver-worker.js` | exécute le solveur hors du fil principal |
| `js/overlay.js` | rendu de la solution sur la photo ou en grille propre |
| `js/app.js` | enchaînement des écrans et interactions |

Le solveur résout chaque ligne exactement par programmation dynamique
(ensemble des placements possibles des blocs), propage les cases déduites vers
les colonnes croisées jusqu'au point fixe, puis branche sur la ligne la moins
indéterminée. Il vérifie aussi l'unicité de la solution : une grille à
plusieurs solutions trahit presque toujours une erreur de lecture des indices.

## Déploiement

Un push sur `main` déclenche `.github/workflows/deploy.yml`, qui publie la
racine du dépôt sur GitHub Pages. Activez d'abord **Settings → Pages →
Source : GitHub Actions**.

Aucune étape de compilation : ce sont des modules ES servis tels quels, tous
les chemins sont relatifs, le site fonctionne donc aussi bien à la racine d'un
domaine que dans un sous-dossier (`/pikview/`).

## Développement local

```sh
node tools/make-icons.mjs     # régénère les icônes
python3 -m http.server 8000   # puis http://localhost:8000
```

La caméra exige un contexte sécurisé : `localhost` convient, une IP locale en
HTTP non.

Le solveur est du JavaScript pur, testable hors navigateur :

```sh
node --input-type=module -e "
  import('./js/solver.js').then(({solvePuzzle}) =>
    console.log(solvePuzzle([[2],[1,1],[2]], [[1,1],[1,1],[1,1]]).status));
"
```
