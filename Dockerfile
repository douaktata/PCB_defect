FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    YOLO_CONFIG_DIR=/tmp/ultralytics YOLO_OFFLINE=true DEVICE=auto
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 pcb && useradd --uid 10001 --gid pcb --create-home pcb
COPY requirements.txt .
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && pip install -r requirements.txt
COPY --chown=pcb:pcb app ./app
COPY --chown=pcb:pcb static ./static
COPY --chown=pcb:pcb models ./models
USER pcb
EXPOSE 8000
HEALTHCHECK --interval=30s --start-period=60s CMD python -c "import urllib.request,json; r=json.load(urllib.request.urlopen('http://localhost:8000/api/health')); raise SystemExit(r['status'] != 'ready')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
