"""Contrats JSON et métriques connues, sans valeurs extrapolées."""

from pydantic import BaseModel, Field

from app.config import CLASSES, LABELS_FR


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float


class Detection(BaseModel):
    class_id: int = Field(ge=0, le=5)
    class_name: str
    confidence: float = Field(ge=0, le=1)
    bbox: BoundingBox


class Prediction(BaseModel):
    filename: str
    width: int
    height: int
    inference_ms: float
    model: str
    device: str
    imgsz: int
    conf: float
    iou: float
    analyzed_at: str
    detections: list[Detection]
    counts: dict[str, int]
    total: int


class Health(BaseModel):
    status: str
    model: str
    device: str
    message: str


def model_metadata() -> dict:
    """Les métriques non communiquées restent explicitement nulles."""
    return {
        "architecture": "YOLO11n",
        "classes": [
            {"id": i, "name": name, "label_fr": LABELS_FR[i],
             "precision": 0.61 if i == 5 else None,
             "recall": 0.79 if i == 4 else None, "map50": None}
            for i, name in enumerate(CLASSES)
        ],
        "metrics": {"precision": 0.91, "recall": 0.91, "map50": 0.905, "map50_95": 0.469},
        "dataset": "Akhatova / PCB Defects",
        "test_boards": 2,
        "warning": "Outil de démonstration, ne remplace pas un contrôle qualité industriel",
        "limits": [
            "Les défauts du jeu de données sont artificiels.",
            "Le jeu de test ne couvre que deux cartes électroniques.",
            "Cuivre parasite : précision 0,61 ; excroissance : rappel 0,79.",
            "Les autres métriques par classe n'ont pas été communiquées.",
            "Une absence de détection ne garantit pas l'absence de défaut.",
        ],
    }
