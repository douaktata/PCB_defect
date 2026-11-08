"""Décodage en mémoire et inférence unique, sérialisée et sans sauvegarde."""

import io
import logging
import os
import threading
import time
import warnings
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import CLASSES, ROOT, Settings
from app.schemas import BoundingBox, Detection, Prediction

logger = logging.getLogger(__name__)
FORMATS = {"JPEG", "PNG", "BMP", "TIFF"}


class InvalidImage(ValueError):
    """Image refusée avant inférence."""


def decode_image(data: bytes, max_pixels: int) -> Image.Image:
    """Normalise l'orientation EXIF et refuse les images invalides ou immenses."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in FORMATS:
                    raise InvalidImage("Format non pris en charge. Utilisez JPG, PNG, BMP ou TIFF.")
                if source.width * source.height > max_pixels:
                    raise InvalidImage("Image trop grande en pixels. Réduisez sa résolution.")
                if getattr(source, "n_frames", 1) > 1:
                    raise InvalidImage("Les fichiers multi-images ne sont pas pris en charge. Exportez une image par fichier.")
                source.load()
                return ImageOps.exif_transpose(source).convert("RGB")
    except InvalidImage:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InvalidImage("Fichier image invalide ou endommagé.") from exc


class InferenceService:
    """Un seul modèle par processus ; verrou autour du prédicteur Ultralytics."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model = None
        self.device = "cpu"
        self.message = "Modèle non chargé."
        self.lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def load(self) -> None:
        """Charge uniquement les poids locaux et contrôle l'ordre des classes."""
        if not self.settings.model_path.is_file():
            self.message = "Modèle absent. Placez bestvff.pt dans models/ puis redémarrez le service."
            logger.warning(self.message)
            return
        try:
            os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".runtime"))
            os.environ.setdefault("YOLO_OFFLINE", "true")
            import torch
            from ultralytics import YOLO

            if self.settings.device == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("CUDA demandé mais indisponible")
            self.device = "cuda" if self.settings.device != "cpu" and torch.cuda.is_available() else "cpu"
            model = YOLO(str(self.settings.model_path), task="detect")
            names = tuple(str(model.names[i]).replace("_", " ").lower() for i in range(len(model.names)))
            if names != CLASSES:
                raise ValueError("L'ordre des classes des poids ne correspond pas aux six classes attendues")
            model.to(self.device)
            self.model = model
            self.message = "Modèle prêt"
            logger.info("Modèle %s prêt sur %s, imgsz=%s", self.settings.model_path.name, self.device, self.settings.imgsz)
        except Exception:
            logger.exception("Impossible de charger le modèle local")
            self.message = "Chargement du modèle impossible. Consultez les journaux du serveur."

    def predict(self, image: Image.Image, filename: str, conf: float, iou: float) -> Prediction:
        """Conserve les coordonnées xyxy déjà exprimées dans l'image d'origine."""
        if self.model is None:
            raise RuntimeError(self.message)
        with self.lock:
            start = time.perf_counter()
            result = self.model.predict(
                source=image, imgsz=self.settings.imgsz, conf=conf, iou=iou,
                device=self.device, verbose=False, save=False, save_txt=False,
                save_crop=False, augment=False, max_det=1000,
            )[0]
            elapsed = (time.perf_counter() - start) * 1000
            if tuple(result.orig_shape) != (image.height, image.width):
                raise RuntimeError("Dimensions de sortie incohérentes")
            boxes = result.boxes.cpu().numpy()
            detections = []
            counts = dict.fromkeys(CLASSES, 0)
            for xyxy, class_id, confidence in zip(boxes.xyxy, boxes.cls, boxes.conf):
                cid = int(class_id)
                x1, y1, x2, y2 = np.clip(xyxy, [0, 0, 0, 0], [image.width, image.height, image.width, image.height]).tolist()
                if x2 <= x1 or y2 <= y1:
                    continue
                detections.append(Detection(class_id=cid, class_name=CLASSES[cid], confidence=float(confidence),
                                            bbox=BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2)))
                counts[CLASSES[cid]] += 1
        return Prediction(
            filename=filename, width=image.width, height=image.height, inference_ms=round(elapsed, 2),
            model=self.settings.model_path.name, device=self.device, imgsz=self.settings.imgsz,
            conf=conf, iou=iou, analyzed_at=datetime.now(timezone.utc).isoformat(),
            detections=detections, counts=counts, total=len(detections),
        )
