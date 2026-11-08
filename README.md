# PCB Inspect

Application locale de démonstration pour inspecter des cartes électroniques avec **YOLO11n**. Interface française, FastAPI, HTML/CSS/JavaScript natif, sans build frontend ni ressource CDN nécessaire. Les images sont traitées en mémoire et ne sont pas conservées sur le disque du serveur.

**Outil de démonstration, ne remplace pas un contrôle qualité industriel.** Une absence de détection ne garantit pas l'absence de défaut.

## Prérequis

- Python **3.10 ou supérieur**, 64 bits ; prévoir plusieurs Go pour PyTorch et les dépendances.
- Le fichier de poids local `models/bestvff.pt`. Une copie identique a été réalisée depuis le fichier initial `model/bestvff.pt`, qui est conservé.
- Un navigateur récent : Edge, Chrome, Firefox ou Safari. Aucun compte ni service distant n'est nécessaire à l'utilisation.
- Internet pour l'installation initiale ; ensuite, l'application et les trois exemples fonctionnent hors ligne.

## Installation et lancement

Depuis la racine du projet, sous PowerShell :

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Sur cette machine, l'environnement `.venv` est déjà préparé. Commande directe :

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Ouvrir **http://127.0.0.1:8000**. Le chargement initial du modèle peut prendre quelques secondes. Une fois l'environnement activé, la commande équivalente est `uvicorn app.main:app --reload`.

Linux / macOS :

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

```

Le modèle est chargé une fois au démarrage de chaque processus. Utiliser **un seul worker** pour éviter de multiplier sa consommation mémoire. Sans `--reload`, le serveur ne redémarre pas lors des modifications de fichiers.

Le CPU est utilisé lorsque CUDA n'est pas disponible. `DEVICE=auto` sélectionne automatiquement CUDA si PyTorch et le GPU le permettent. Pour forcer le CPU : `$env:DEVICE='cpu'`. Pour utiliser CUDA, installer une distribution PyTorch adaptée à son pilote selon la [documentation officielle PyTorch](https://pytorch.org/get-started/locally/).

## Utilisation

1. Déposer une ou plusieurs images JPG, PNG, BMP ou TIFF, ou cliquer sur **Essayer avec un exemple**. Le bouton parcourt les trois exemples à chaque clic ; le modèle ne lance pas d'analyse sans clic sur le bouton d'analyse.
2. Régler la confiance (0,05–0,95 ; défaut 0,25), puis éventuellement l'IoU dans les paramètres avancés (défaut 0,70).
3. Lancer l'analyse. Les images d'un lot sont traitées à la suite ; une erreur sur une image n'interrompt pas les suivantes.
4. Inspecter le canvas : molette pour zoomer, glisser pour déplacer, double-clic pour ajuster. Sur écran tactile : glisser et pincer. Au clavier : `+`, `-`, flèches et `0`.
5. Survoler ou sélectionner une ligne pour mettre en évidence sa boîte ; cliquer ou appuyer sur Entrée pour zoomer sur le défaut. Les titres du tableau permettent le tri. Cliquer sur une classe de la légende masque ou affiche ses boîtes.
6. Exporter le PNG annoté, le JSON, le CSV ou le rapport HTML autonome. Ouvrir ce rapport puis cliquer sur **Imprimer / Enregistrer en PDF**. Il contient la date, le modèle, les seuils, les dimensions, l'image annotée et le tableau, sur une page A4 par image. Les exports incluent **toutes les détections de l'analyse**, même si certaines classes sont masquées dans la vue.
7. L'historique contient une miniature cliquable pour chaque analyse réussie et conserve les seuils d'origine. Il existe uniquement en mémoire dans l'onglet : recharger la page le vide. Seul le choix du thème est enregistré dans le stockage local du navigateur.

Les seuils changent les prochaines analyses ; ils ne modifient pas rétroactivement les résultats affichés. Le verdict « Aucun défaut détecté » signifie uniquement qu'aucune boîte n'a dépassé les seuils retenus.

Les limites s'appliquent **par image** : 25 Mio par défaut (25 × 1024² octets) et 40 millions de pixels décompressés. Les fichiers multi-images sont refusés : exporter chaque page ou frame séparément. L'orientation EXIF est normalisée à l'identique pour la prévisualisation et l'inférence. Les coordonnées JSON se réfèrent aux pixels de cette image d'origine orientée, jamais au canevas d'entrée de 1280 pixels.

## API

| Méthode | Route | Réponse |
| --- | --- | --- |
| GET | `/api/health` | `status` (`ready` / `unavailable`), `model`, `device` (`cpu` / `cuda`), message français |
| GET | `/api/model` | Classes dans l'ordre, traductions, métriques, `imgsz`, seuils et limites |
| POST | `/api/predict` | Multipart `file`, `conf` et `iou` facultatifs ; résultats JSON |
| GET | `/api/examples` | Jusqu'à trois images présentes dans `static/examples/` |
| POST | `/api/preview` | Route interne de décodage multipart en PNG, notamment pour TIFF/BMP et EXIF |

`/api/health` répond 200 même si le modèle est absent, avec `status=unavailable` ; l'inférence répond alors **503**. Autres erreurs : **400** formulaire multipart invalide, **413** taille dépassée, **415** extension ou contenu image invalide, **422** seuil invalide, **500** erreur interne. Les réponses n'exposent pas de stack trace ; les détails internes restent dans les logs.

Exemple PowerShell (utiliser `curl.exe`, pas l'alias PowerShell `curl`) :

```powershell
curl.exe -X POST http://127.0.0.1:8000/api/predict -F "file=@static/examples/01_missing_hole_01.jpg" -F "conf=0.25" -F "iou=0.7"
```

Structure de réponse (valeurs illustratives pour les détections, pas des métriques de test) :

```json
{
  "filename": "carte.jpg", "width": 3000, "height": 2000,
  "inference_ms": 450.0, "model": "bestvff.pt", "device": "cpu",
  "imgsz": 1280, "conf": 0.25, "iou": 0.7,
  "analyzed_at": "2026-11-01T12:00:00+00:00",
  "detections": [{
    "class_id": 0, "class_name": "missing hole", "confidence": 0.91,
    "bbox": {"x1": 2400, "y1": 700, "x2": 2430, "y2": 730}
  }],
  "counts": {"missing hole": 1, "mouse bite": 0, "open circuit": 0, "short": 0, "spur": 0, "spurious copper": 0},
  "total": 1
}
```

Le schéma OpenAPI est disponible à `/openapi.json`. L'interface `/docs` de FastAPI peut utiliser des ressources CDN : elle n'est pas nécessaire à l'application, qui reste autonome hors ligne.

## Configuration

Définir les variables dans le terminal avant le lancement ou avec Docker `-e`. `.env.example` sert d'aide ; un fichier `.env` n'est pas chargé automatiquement.

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `MODEL_PATH` | Chemin absolu vers `models/bestvff.pt` | Poids locaux uniquement |
| `IMGSZ` | `1280` | Toute autre valeur est refusée pour respecter l'entraînement |
| `DEFAULT_CONF` | `0.25` | Confiance initiale |
| `DEFAULT_IOU` | `0.7` | IoU initial |
| `MAX_UPLOAD_MB` | `25` | Taille maximale du fichier, en Mio entiers |
| `MAX_IMAGE_PIXELS` | `40000000` | Limite de décompression |
| `DEVICE` | `auto` | `auto`, `cpu` ou `cuda` |

## Modèle et limites

| ID | Classe | Précision | Rappel | mAP50 |
| --- | --- | --- | --- | --- |
| 0 | missing hole | — | — | — |
| 1 | mouse bite | — | — | — |
| 2 | open circuit | — | — | — |
| 3 | short | — | — | — |
| 4 | spur | — | 0,79 | — |
| 5 | spurious copper | 0,61 | — | — |
| **Global** | | **0,91** | **0,91** | **0,905** |

**mAP50–95 global : 0,469.** Les valeurs par classe non fournies restent inconnues ; elles ne sont pas remplacées par les moyennes globales.

Le dataset Akhatova / PCB Defects contient des **défauts artificiels**. Le test porte sur **deux cartes seulement**. Les classes `spurious copper` et `spur` sont les plus faibles selon les valeurs communiquées. Le domaine d'acquisition, l'éclairage, les matériaux et la taille des défauts peuvent réduire les performances sur de nouvelles images. Les scores de confiance ne constituent pas des probabilités calibrées.

Les trois exemples proviennent du dépôt public Tiny-Defect-Detection-for-PCB : voir [leurs sources](static/examples/SOURCES.md). Ils servent à la démonstration, sans prétendre à une mesure indépendante de performance.

Les poids ne sont ni modifiés ni réentraînés. Le serveur contrôle les noms et l'ordre des six classes au chargement. Il utilise directement [`boxes.xyxy` d'Ultralytics](https://docs.ultralytics.com/modes/predict/), en pixels de l'image d'origine, sans appliquer une deuxième mise à l'échelle. Les inférences sont sérialisées pour protéger le prédicteur partagé.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

Les tests API utilisent un prédicteur déterministe et ne chargent pas les poids : ils couvrent disponibilité, image synthétique 3000 px, coordonnées supérieures à 1280, formats, orientation EXIF, métriques, fichier invalide, limites de taille et de pixels, seuils, absence du modèle et maintien des fichiers en mémoire.

Pour vérifier le vrai modèle dans un navigateur, démarrer le serveur puis lancer :

```powershell
.\.venv\Scripts\python.exe scripts/verify_browser.py
```

Ce contrôle utilise Playwright avec Microsoft Edge installé. Il analyse les trois vraies photos PCB, vérifie les dimensions et les boîtes, les interactions, les exports, les vues mobile et les thèmes. Les preuves sont écrites dans `artifacts/` (ignoré par Git).

Validation locale : **21 tests pytest réussis**, puis contrôle navigateur avec le vrai modèle sur trois photographies, dont une de **3034 × 1586 px**. Les pixels des boîtes ont été contrôlés sur le canvas aux positions issues du JSON, notamment au-delà de 1280 px. Le rapport a été imprimé en PDF et vérifié sur une page. Aucun réentraînement ni ajustement des prédictions n'a été effectué. L'image nommée `04_mouse_bite_10.jpg` produit une détection `missing hole` avec ces poids : le nom du fichier n'est pas utilisé pour forcer la classe. Ce contrôle valide le fonctionnement logiciel et n'est pas une nouvelle évaluation de performance.

## Docker

```bash
docker build -t pcb-inspect .
docker run --rm -p 8000:8000 pcb-inspect
```

Image Python slim, utilisateur non root, poids inclus dans `models/`, PyTorch CPU. Le contrôle de santé exige que le modèle soit prêt. Pour monter d'autres poids : `-v /chemin/bestvff.pt:/app/models/bestvff.pt:ro`. Une image PyTorch compatible CUDA et l'exposition du GPU au conteneur sont nécessaires pour utiliser un GPU dans Docker.

Le build Docker nécessite un moteur Docker démarré. Il n'a pas été exécuté lors de la validation locale initiale, le moteur étant arrêté ; l'application Python a été exécutée directement.

## Structure

```text
app/
  __init__.py
  config.py                 Variables, classes et limites
  inference.py              Chargement, décodage et prédictions
  main.py                   API et service des fichiers statiques
  schemas.py                Contrats JSON et métriques
static/
  index.html                Inspection, historique, à propos
  css/styles.css            Thèmes et styles responsive
  js/app.js                 État de session et interactions
  js/viewer.js              Canvas, zoom, déplacement, boîtes
  js/exports.js             Exports et rapport autonome
  examples/                 Trois photos et SOURCES.md
models/bestvff.pt            Copie identique des poids fournis
model/bestvff.pt             Fichier initial conservé
tests/test_api.py
tests/test_inference.py
scripts/verify_browser.py
requirements.txt
requirements-dev.txt
pytest.ini
Dockerfile
.dockerignore
.env.example
.gitignore
README.md
```

## Captures d'écran

Le contrôle navigateur produit `artifacts/inspection-desktop.png`, `artifacts/inspection-result.png`, `artifacts/inspection-mobile.png` et `artifacts/inspection-dark.png`. À ajouter à un rapport ou une soutenance après validation sur les données de présentation.
