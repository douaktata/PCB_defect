"""Vérifie l'appel du prédicteur et l'absence de remise à l'échelle des boîtes."""

from types import SimpleNamespace

import numpy as np
from PIL import Image

from app.config import Settings
from app.inference import InferenceService


def test_predict_uses_1280_and_original_xyxy():
    received = {}
    boxes = SimpleNamespace(xyxy=np.array([[2500, 1500, 2525, 1520]], dtype=float),
                            cls=np.array([5]), conf=np.array([0.82]))
    boxes.cpu = lambda: boxes
    boxes.numpy = lambda: boxes

    class Model:
        def predict(self, **kwargs):
            received.update(kwargs)
            return [SimpleNamespace(orig_shape=(2000, 3000), boxes=boxes)]

    service = InferenceService(Settings())
    service.model = Model()
    result = service.predict(Image.new("RGB", (3000, 2000)), "pcb.jpg", 0.25, 0.7)
    assert received["imgsz"] == 1280
    assert received["device"] == "cpu"
    assert received["save"] is False
    assert result.detections[0].bbox.x1 == 2500
    assert result.detections[0].bbox.y2 == 1520
    assert result.counts["spurious copper"] == 1
