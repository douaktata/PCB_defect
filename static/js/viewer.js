/** Canvas en coordonnées CSS ; les boîtes restent dans les pixels de l'image. */
export const COLORS = ['#e0673c', '#a878e8', '#d14565', '#dd9c1c', '#2995d0', '#25a58c'];

export function paintBoxes(ctx, detections, {scale = 1, hidden = new Set(), active = -1, imageWidth = ctx.canvas.width} = {}) {
  for (const [index, detection] of detections.entries()) {
    if (hidden.has(detection.class_id)) continue;
    const {x1, y1, x2, y2} = detection.bbox;
    const color = COLORS[detection.class_id];
    const highlighted = active === index;
    ctx.strokeStyle = color;
    ctx.lineWidth = (highlighted ? 3.5 : 2) / scale;
    ctx.fillStyle = `${color}${highlighted ? '40' : '0a'}`;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const fontSize = 11 / scale;
    ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
    const label = `${index + 1} · ${detection.class_name} ${(detection.confidence * 100).toFixed(0)} %`;
    const labelWidth = ctx.measureText(label).width + 10 / scale;
    const labelHeight = 19 / scale;
    const labelX = Math.max(0, Math.min(x1, imageWidth - labelWidth));
    const labelY = y1 >= labelHeight ? y1 - labelHeight : y1;
    ctx.fillStyle = color;
    ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
    ctx.fillStyle = '#101820';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, labelX + 5 / scale, labelY + labelHeight / 2);
  }
}

export class ImageViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.detections = [];
    this.hidden = new Set();
    this.active = -1;
    this.boxesVisible = true;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.drag = null;
    this.pointers = new Map();
    this.width = 0;
    this.height = 0;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement);
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    }, {passive: false});
    canvas.addEventListener('dblclick', () => this.fit());
    canvas.addEventListener('pointerdown', event => {
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      this.drag = {x: event.clientX, y: event.clientY};
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.pointers.has(event.pointerId)) return;
      if (this.pointers.size === 2) {
        const previous = [...this.pointers.values()];
        const oldDistance = Math.hypot(previous[0].x - previous[1].x, previous[0].y - previous[1].y);
        this.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
        const next = [...this.pointers.values()];
        const newDistance = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
        const rect = canvas.getBoundingClientRect();
        if (oldDistance) this.zoom(newDistance / oldDistance, (next[0].x + next[1].x) / 2 - rect.left, (next[0].y + next[1].y) / 2 - rect.top);
      } else if (this.drag) {
        this.x += event.clientX - this.drag.x;
        this.y += event.clientY - this.drag.y;
        this.draw();
      }
      this.pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
      this.drag = {x: event.clientX, y: event.clientY};
    });
    const release = event => {
      this.pointers.delete(event.pointerId);
      const remaining = [...this.pointers.values()][0];
      this.drag = remaining || null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('keydown', event => {
      if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
      if (event.key === '+' || event.key === '=') this.zoom(1.3);
      if (event.key === '-') this.zoom(1 / 1.3);
      if (event.key === '0') this.fit();
      if (event.key === 'ArrowLeft') this.x += 40;
      if (event.key === 'ArrowRight') this.x -= 40;
      if (event.key === 'ArrowUp') this.y += 40;
      if (event.key === 'ArrowDown') this.y -= 40;
      this.draw();
    });
  }

  resize() {
    const {width, height} = this.canvas.parentElement.getBoundingClientRect();
    if (!width || !height) return;
    const sizeChanged = this.width !== width || this.height !== height;
    this.width = width;
    this.height = height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    if (this.image && sizeChanged) this.fit();
    else this.draw();
  }

  setImage(image, detections = []) {
    this.image = image;
    this.detections = detections;
    this.hidden.clear();
    this.active = -1;
    this.resize();
    this.fit();
  }

  fit() {
    if (!this.image || !this.width) return;
    this.scale = Math.min((this.width - 32) / this.image.naturalWidth, (this.height - 32) / this.image.naturalHeight);
    this.x = (this.width - this.image.naturalWidth * this.scale) / 2;
    this.y = (this.height - this.image.naturalHeight * this.scale) / 2;
    this.draw();
  }

  zoom(factor, px = this.width / 2, py = this.height / 2) {
    if (!this.image) return;
    const next = Math.min(32, Math.max(0.01, this.scale * factor));
    this.x = px - (px - this.x) * next / this.scale;
    this.y = py - (py - this.y) * next / this.scale;
    this.scale = next;
    this.draw();
  }

  focus(index) {
    const box = this.detections[index]?.bbox;
    if (!box) return;
    this.scale = Math.min(8, Math.max(0.1, Math.min(this.width / ((box.x2 - box.x1) * 5), this.height / ((box.y2 - box.y1) * 5))));
    this.x = this.width / 2 - (box.x1 + box.x2) / 2 * this.scale;
    this.y = this.height / 2 - (box.y1 + box.y2) / 2 * this.scale;
    this.active = index;
    this.draw();
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (!this.image) return;
    this.ctx.save();
    this.ctx.translate(this.x, this.y);
    this.ctx.scale(this.scale, this.scale);
    this.ctx.drawImage(this.image, 0, 0);
    if (this.boxesVisible) paintBoxes(this.ctx, this.detections, {scale: this.scale, hidden: this.hidden, active: this.active, imageWidth: this.image.naturalWidth});
    this.ctx.restore();
    document.querySelector('#zoom-label').textContent = `${Math.round(this.scale * 100)} %`;
  }
}
