"""Configuration de l'application par variables d'environnement."""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLASSES = ("missing hole", "mouse bite", "open circuit", "short", "spur", "spurious copper")
LABELS_FR = ("Trou manquant", "Échancrure", "Circuit ouvert", "Court-circuit", "Excroissance", "Cuivre parasite")


@dataclass(frozen=True)
class Settings:
    model_path: Path = ROOT / "models" / "bestvff.pt"
    imgsz: int = 1280
    default_conf: float = 0.25
    default_iou: float = 0.7
    max_upload_bytes: int = 25 * 1024 * 1024
    max_image_pixels: int = 40_000_000
    device: str = "auto"

    def __post_init__(self) -> None:
        if self.imgsz != 1280:
            raise ValueError("IMGSZ doit être 1280 pour ce modèle entraîné à cette résolution.")
        if not 0.05 <= self.default_conf <= 0.95 or not 0 <= self.default_iou <= 1:
            raise ValueError("Seuils par défaut invalides.")
        if self.max_upload_bytes < 1 or self.max_image_pixels < 1:
            raise ValueError("Les limites d'image doivent être positives.")
        if self.device not in {"auto", "cpu", "cuda"}:
            raise ValueError("DEVICE doit être auto, cpu ou cuda.")

    @classmethod
    def from_env(cls) -> "Settings":
        """Lit l'environnement sans dépendance à un fichier .env."""
        return cls(
            model_path=Path(os.getenv("MODEL_PATH", str(ROOT / "models/bestvff.pt"))).resolve(),
            imgsz=int(os.getenv("IMGSZ", "1280")),
            default_conf=float(os.getenv("DEFAULT_CONF", "0.25")),
            default_iou=float(os.getenv("DEFAULT_IOU", "0.7")),
            max_upload_bytes=int(os.getenv("MAX_UPLOAD_MB", "25")) * 1024 * 1024,
            max_image_pixels=int(os.getenv("MAX_IMAGE_PIXELS", "40000000")),
            device=os.getenv("DEVICE", "auto"),
        )
