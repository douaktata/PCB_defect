"""API FastAPI et fichiers statiques de PCB Inspect."""

import io
import logging
import math
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from app.config import ROOT, Settings
from app.inference import InferenceService, InvalidImage, decode_image
from app.schemas import Health, Prediction, model_metadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")
logger = logging.getLogger(__name__)
EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}


class UploadLimitMiddleware:
    """Borne le corps multipart avant son décodage, même sans Content-Length."""

    def __init__(self, app, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope["path"] not in {"/api/predict", "/api/preview"}:
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes + 65536:
                await JSONResponse(status_code=413, content={"detail": "Fichier trop volumineux pour la limite configurée."})(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)


@asynccontextmanager
async def uploaded_image(request: Request):
    """Le spool reste en RAM, le corps complet étant borné par le middleware."""
    settings = request.app.state.settings
    if not request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        raise HTTPException(415, "Utilisez un formulaire multipart avec un champ file.")
    parser = MultiPartParser(request.headers, request.stream(), max_files=1, max_fields=2)
    parser.spool_max_size = settings.max_upload_bytes + 65537
    parser.max_file_size = settings.max_upload_bytes + 65537
    try:
        form = await parser.parse()
    except (MultiPartException, ValueError) as exc:
        raise HTTPException(400, "Formulaire multipart invalide : une seule image est attendue.") from exc
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(422, "Le champ file doit contenir une image.")
        filename = (upload.filename or "image").replace("\\", "/").split("/")[-1][:200]
        if Path(filename).suffix.lower() not in EXTENSIONS:
            raise HTTPException(415, "Extension non prise en charge. Utilisez JPG, PNG, BMP ou TIFF.")
        data = await upload.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(413, "Fichier trop volumineux pour la limite configurée.")
        try:
            image = await run_in_threadpool(decode_image, data, settings.max_image_pixels)
        except InvalidImage as exc:
            raise HTTPException(415, str(exc)) from exc
        try:
            yield image, filename, form
        finally:
            image.close()
    finally:
        await form.close()


def threshold(value, default: float, low: float, high: float, name: str) -> float:
    try:
        parsed = float(value) if value is not None else default
        if not math.isfinite(parsed) or not low <= parsed <= high:
            raise ValueError
        return parsed
    except (TypeError, ValueError) as exc:
        raise HTTPException(422, f"Le seuil {name} doit être compris entre {low} et {high}.") from exc


PREDICT_SCHEMA = {"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
    "type": "object", "required": ["file"], "properties": {
        "file": {"type": "string", "format": "binary"},
        "conf": {"type": "number", "default": 0.25, "minimum": 0.05, "maximum": 0.95},
        "iou": {"type": "number", "default": 0.7, "minimum": 0, "maximum": 1},
    }}}}}}


def create_app(settings: Settings | None = None, service=None) -> FastAPI:
    """Fabrique injectable pour tester l'API sans charger les poids."""
    config = settings or Settings.from_env()
    engine = service or InferenceService(config)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        await run_in_threadpool(engine.load)
        yield

    application = FastAPI(title="PCB Inspect", version="1.0.0", lifespan=lifespan)
    application.state.settings = config
    application.state.engine = engine
    application.add_middleware(UploadLimitMiddleware, max_bytes=config.max_upload_bytes)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"detail": "Paramètres de requête invalides."})

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        logger.error("Erreur sur %s", request.url.path, exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "Erreur interne. Consultez les journaux du serveur."})

    @application.get("/api/health", response_model=Health)
    async def health():
        return Health(status="ready" if engine.ready else "unavailable", model=config.model_path.name,
                      device=engine.device, message=engine.message)

    @application.get("/api/model")
    async def model():
        return {**model_metadata(), "model": config.model_path.name, "imgsz": config.imgsz,
                "default_conf": config.default_conf, "default_iou": config.default_iou,
                "max_upload_bytes": config.max_upload_bytes, "max_image_pixels": config.max_image_pixels}

    @application.get("/api/examples")
    async def examples():
        folder = ROOT / "static/examples"
        files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS)[:3]
        return {"examples": [{"name": p.name, "url": "/static/examples/" + quote(p.name)} for p in files]}

    @application.post("/api/predict", response_model=Prediction, openapi_extra=PREDICT_SCHEMA)
    async def predict(request: Request):
        async with uploaded_image(request) as (image, filename, form):
            conf = threshold(form.get("conf"), config.default_conf, 0.05, 0.95, "de confiance")
            iou = threshold(form.get("iou"), config.default_iou, 0, 1, "IoU")
            if not engine.ready:
                raise HTTPException(503, engine.message)
            return await run_in_threadpool(engine.predict, image, filename, conf, iou)

    @application.post("/api/preview", include_in_schema=False)
    async def preview(request: Request):
        async with uploaded_image(request) as (image, filename, form):
            output = io.BytesIO()
            await run_in_threadpool(image.save, output, format="PNG")
            return Response(output.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})

    @application.get("/", include_in_schema=False)
    @application.get("/about", include_in_schema=False)
    async def index():
        return FileResponse(ROOT / "static/index.html")

    application.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return application


app = create_app()
