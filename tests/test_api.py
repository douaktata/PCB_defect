"""Tests du contrat HTTP et des protections avant inférence."""

import io
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import CLASSES, Settings
from app.inference import InferenceService
from app.main import create_app
from app.schemas import BoundingBox, Detection, Prediction


class FakeService:
    """Prédiction déterministe qui vérifie les dimensions réellement décodées."""

    ready = True
    device = "cpu"
    message = "Modèle prêt"

    def load(self):
        pass

    def predict(self, image, filename, conf, iou):
        detection = Detection(class_id=0, class_name=CLASSES[0], confidence=0.91,
                              bbox=BoundingBox(x1=image.width - 90, y1=30, x2=image.width - 30, y2=90))
        return Prediction(filename=filename, width=image.width, height=image.height, inference_ms=2.0,
                          model="bestvff.pt", device="cpu", imgsz=1280, conf=conf, iou=iou,
                          analyzed_at=datetime.now(timezone.utc).isoformat(), detections=[detection],
                          counts={name: int(index == 0) for index, name in enumerate(CLASSES)}, total=1)


@pytest.fixture
def client():
    with TestClient(create_app(Settings(), FakeService())) as test_client:
        yield test_client


def image_bytes(size=(3000, 1800), format="PNG", **kwargs):
    output = io.BytesIO()
    Image.new("RGB", size, "#29735d").save(output, format=format, **kwargs)
    return output.getvalue()


def test_health(client):
    assert client.get("/api/health").json() == {
        "status": "ready", "model": "bestvff.pt", "device": "cpu", "message": "Modèle prêt"}


def test_predict_original_coordinates(client):
    response = client.post("/api/predict", files={"file": ("pcb.png", image_bytes(), "image/png")},
                           data={"conf": "0.25", "iou": "0.7"})
    assert response.status_code == 200
    result = response.json()
    assert (result["width"], result["height"], result["imgsz"]) == (3000, 1800, 1280)
    assert result["detections"][0]["bbox"] == {"x1": 2910, "y1": 30, "x2": 2970, "y2": 90}
    assert result["counts"]["missing hole"] == 1


@pytest.mark.parametrize("filename,data", [("document.txt", b"pas une image"), ("faux.jpg", b"pas une image")])
def test_reject_non_image(client, filename, data):
    response = client.post("/api/predict", files={"file": (filename, data)})
    assert response.status_code == 415
    assert isinstance(response.json()["detail"], str)


def test_reject_oversized_file():
    with TestClient(create_app(Settings(max_upload_bytes=100), FakeService())) as client:
        response = client.post("/api/predict", files={"file": ("large.png", b"x" * 101)})
        assert response.status_code == 413
        # Rejet avant parsing du corps, y compris pour un transfert sans Content-Length.
        response = client.post("/api/predict", content=iter([b"x" * 70000]),
                               headers={"Content-Type": "multipart/form-data; boundary=test"})
        assert response.status_code == 413


@pytest.mark.parametrize("conf,iou", [("nan", "0.7"), ("0.01", "0.7"), ("0.25", "1.1"), ("abc", "0.7")])
def test_reject_invalid_thresholds(client, conf, iou):
    response = client.post("/api/predict", files={"file": ("pcb.png", image_bytes((200, 100)))},
                           data={"conf": conf, "iou": iou})
    assert response.status_code == 422


def test_missing_model(tmp_path):
    config = Settings(model_path=tmp_path / "absent.pt")
    with TestClient(create_app(config, InferenceService(config))) as client:
        assert client.get("/api/health").json()["status"] == "unavailable"
        response = client.post("/api/predict", files={"file": ("pcb.png", image_bytes((100, 100)))})
        assert response.status_code == 503
        assert "Modèle absent" in response.json()["detail"]


@pytest.mark.parametrize("extension,format", [("bmp", "BMP"), ("tiff", "TIFF"), ("jpg", "JPEG")])
def test_preview_decodes_formats(client, extension, format):
    response = client.post("/api/preview", files={"file": (f"pcb.{extension}", image_bytes((91, 53), format))})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(response.content)).size == (91, 53)


def test_exif_orientation_consistent(client):
    exif = Image.Exif()
    exif[274] = 6
    data = image_bytes((300, 100), "JPEG", exif=exif)
    preview = client.post("/api/preview", files={"file": ("rotated.jpg", data)})
    prediction = client.post("/api/predict", files={"file": ("rotated.jpg", data)}).json()
    assert Image.open(io.BytesIO(preview.content)).size == (100, 300)
    assert (prediction["width"], prediction["height"]) == (100, 300)


def test_upload_never_rolls_to_disk(client, monkeypatch):
    import starlette.formparsers
    from tempfile import SpooledTemporaryFile

    opened = []

    def tracked_spool(*args, **kwargs):
        spool = SpooledTemporaryFile(*args, **kwargs)
        opened.append(spool)
        return spool

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", tracked_spool)
    # BMP incompressible > 1 Mio : dépasse le spool par défaut de Starlette.
    response = client.post("/api/preview", files={"file": ("large.bmp", image_bytes((1000, 600), "BMP"))})
    assert response.status_code == 200
    assert opened and all(not spool._rolled for spool in opened)


def test_model_metrics_not_invented(client):
    metadata = client.get("/api/model").json()
    assert metadata["metrics"] == {"precision": 0.91, "recall": 0.91, "map50": 0.905, "map50_95": 0.469}
    assert metadata["classes"][4]["recall"] == 0.79
    assert metadata["classes"][5]["precision"] == 0.61
    assert all(cls["map50"] is None for cls in metadata["classes"])


def test_static_pages_and_examples(client):
    assert client.get("/").status_code == 200
    assert client.get("/about").status_code == 200
    assert "<html lang=\"fr\">" in client.get("/").text
    for example in client.get("/api/examples").json()["examples"]:
        assert client.get(example["url"]).status_code == 200


def test_imgsz_cannot_change():
    with pytest.raises(ValueError, match="1280"):
        Settings(imgsz=640)


def test_pixel_limit():
    with TestClient(create_app(Settings(max_image_pixels=100), FakeService())) as client:
        response = client.post("/api/predict", files={"file": ("pcb.png", image_bytes((11, 10)))})
        assert response.status_code == 415


def test_reject_multiple_images_in_one_request(client):
    response = client.post("/api/predict", files=[("file", ("one.png", b"one")), ("file", ("two.png", b"two"))])
    assert response.status_code == 400
