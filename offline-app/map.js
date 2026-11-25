"use strict";

window.REGION_SHAPES = {};
const geometryLoads = new Map();

function loadGeometry(code) {
  if (!geometryLoads.has(code)) {
    geometryLoads.set(code, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "map/" + code + ".js";
      script.onload = () => {
        if (window.REGION_SHAPES[code]) resolve(window.REGION_SHAPES[code]);
        else reject(new Error("지도 데이터가 비어 있습니다."));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("로컬 지도 파일을 읽을 수 없습니다. 앱 폴더의 map 파일을 확인하세요."));
      };
      document.head.append(script);
    }).catch(error => {
      geometryLoads.delete(code);
      throw error;
    }));
  }
  return geometryLoads.get(code);
}

function mapPoint([lon, lat]) {
  return [lon * 10000, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 1800000 / Math.PI];
}

class StationMap {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onSelect = onSelect;
    this.paths = [];
    this.points = [];
    this.zoom = 1;
    this.center = [0, 0];
    this.canvas.addEventListener("wheel", event => {
      if (!this.bounds) return;
      event.preventDefault();
      this.changeZoom(Math.exp(-Math.sign(event.deltaY) * 0.23), event.offsetX, event.offsetY);
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", event => {
      if (!this.bounds || this.drag || event.button !== 0) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", event => {
      const drag = this.drag;
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.pan(dx, dy);
    });
    this.canvas.addEventListener("pointerup", event => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      if (!this.drag.moved) this.selectAt(event.offsetX, event.offsetY);
      this.drag = null;
    });
    this.canvas.addEventListener("lostpointercapture", () => { this.drag = null; });
    this.canvas.addEventListener("keydown", event => {
      if (!this.bounds) return;
      const movement = { ArrowUp: [0, 45], ArrowDown: [0, -45], ArrowLeft: [45, 0], ArrowRight: [-45, 0] };
      if (movement[event.key]) this.pan(...movement[event.key]);
      else if (event.key === "+" || event.key === "=") this.changeZoom(1.35);
      else if (event.key === "-") this.changeZoom(1 / 1.35);
      else if (event.key === "Home") this.fit();
      else return;
      event.preventDefault();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setRegion(geometry, codes, stations, connections) {
    const active = new Set(codes || Object.keys(geometry));
    this.bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    this.paths = Object.entries(geometry).map(([code, polygons]) => {
      const path = new Path2D();
      const selected = active.has(code);
      for (const polygon of polygons) {
        for (const ring of polygon) {
          for (let i = 0; i < ring.length; i++) {
            const [x, y] = ring[i];
            if (selected) this.extend(x, y);
            if (i) path.lineTo(x, y);
            else path.moveTo(x, y);
          }
          path.closePath();
        }
      }
      return { path, selected };
    });
    this.points = stations.filter(row => row.coords).map(station => ({
      station, point: mapPoint(station.coords), linked: connections.get(station)?.status === "linked",
    }));
    this.selected = null;
    this.fit();
  }

  extend(x, y) {
    const box = this.bounds;
    box.west = Math.min(box.west, x);
    box.east = Math.max(box.east, x);
    box.south = Math.min(box.south, y);
    box.north = Math.max(box.north, y);
  }

  clear() {
    this.paths = [];
    this.points = [];
    this.bounds = null;
    this.selected = null;
    this.draw();
  }

  fit() {
    if (!this.bounds) return;
    const { west, east, south, north } = this.bounds;
    this.center = [(west + east) / 2, (south + north) / 2];
    this.zoom = 1;
    this.draw();
  }

  scale() {
    const { west, east, south, north } = this.bounds;
    return this.zoom * Math.min(
      Math.max(this.canvas.clientWidth - 48, 1) / Math.max(east - west, 1),
      Math.max(this.canvas.clientHeight - 48, 1) / Math.max(north - south, 1),
    );
  }

  pixel([x, y], scale) {
    return [this.canvas.clientWidth / 2 + (x - this.center[0]) * scale,
      this.canvas.clientHeight / 2 - (y - this.center[1]) * scale];
  }

  pan(dx, dy) {
    const scale = this.scale();
    this.center[0] -= dx / scale;
    this.center[1] += dy / scale;
    this.draw();
  }

  changeZoom(factor, x = this.canvas.clientWidth / 2, y = this.canvas.clientHeight / 2) {
    if (!this.bounds) return;
    const before = this.scale();
    this.zoom = Math.max(0.55, Math.min(48, this.zoom * factor));
    const delta = 1 / before - 1 / this.scale();
    this.center[0] += (x - this.canvas.clientWidth / 2) * delta;
    this.center[1] -= (y - this.canvas.clientHeight / 2) * delta;
    this.draw();
  }

  selectAt(x, y) {
    const scale = this.scale();
    let nearest, best = 11;
    for (const point of this.points) {
      const [px, py] = this.pixel(point.point, scale);
      const distance = Math.hypot(px - x, py - y);
      if (distance <= best) {
        best = distance;
        nearest = point.station;
      }
    }
    if (nearest) this.onSelect(nearest);
  }

  select(station, reveal) {
    this.selected = station;
    if (reveal && this.bounds && station.coords) {
      this.center = mapPoint(station.coords);
    }
    this.draw();
  }

  draw() {
    const { canvas, context } = this;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!this.bounds) return;
    const scale = this.scale();
    const [left, top] = this.pixel([0, 0], scale);
    context.save();
    context.transform(scale, 0, 0, -scale, left, top);
    for (const { path, selected } of this.paths) {
      context.fillStyle = selected ? "#e1edda" : "#e4edf1";
      context.strokeStyle = selected ? "#81a792" : "#acbec8";
      context.lineWidth = (selected ? 0.8 : 0.6) / scale;
      context.fill(path, "evenodd");
      context.stroke(path);
    }
    context.restore();
    for (const { station, point, linked } of this.points) {
      if (station !== this.selected) this.drawPin(point, scale, linked ? "#007b60" : "#5b6d79", 4.5);
    }
    if (this.selected?.coords) this.drawPin(mapPoint(this.selected.coords), scale, "#b14c17", 8);
  }

  drawPin(point, scale, fill, radius) {
    const [x, y] = this.pixel(point, scale);
    const context = this.context;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = "#fff";
    context.lineWidth = 1.5;
    context.stroke();
  }
}
