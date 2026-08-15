import { previewServer, type SceneMeta, type LedPosition, type Frame } from "./previewServerClient";

const DEVICE = "eaves";
const FPS = 24;
const CLIP_DURATION = 4;

const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas")!;
const ctx = canvas.getContext("2d")!;
const sceneSelect = document.querySelector<HTMLSelectElement>("#scene-select")!;
const descriptionEl = document.querySelector<HTMLParagraphElement>("#scene-description")!;
const reloadButton = document.querySelector<HTMLButtonElement>("#reload-button")!;
const statusOverlay = document.querySelector<HTMLDivElement>("#status-overlay")!;

let scenes: SceneMeta[] = [];
let positions: LedPosition[] = [];
let frames: Frame[] = [];
let animationHandle = 0;
let frameStartTime = 0;

function showError(message: string | null): void {
  if (message) {
    statusOverlay.textContent = message;
    statusOverlay.hidden = false;
  } else {
    statusOverlay.hidden = true;
  }
}

function resizeCanvasForDisplay(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawFrame(frame: Frame | undefined): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#080a17");
  gradient.addColorStop(1, "#141a2e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  if (!frame || frame.colors.length !== positions.length) return;

  for (let i = 0; i < positions.length; i++) {
    const [r, g, b] = frame.colors[i];
    const brightness = (r + g + b) / 765;
    const cx = positions[i].x * width;
    const cy = positions[i].y * height;
    const color = `rgb(${r}, ${g}, ${b})`;

    if (brightness > 0.05) {
      ctx.globalAlpha = 0.35 * brightness;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function stopPlayback(): void {
  if (animationHandle) cancelAnimationFrame(animationHandle);
  animationHandle = 0;
}

function startPlayback(): void {
  stopPlayback();
  if (frames.length === 0) return;
  frameStartTime = performance.now();

  const step = () => {
    const elapsed = (performance.now() - frameStartTime) / 1000;
    const index = Math.floor(elapsed * FPS) % frames.length;
    drawFrame(frames[index]);
    animationHandle = requestAnimationFrame(step);
  };
  animationHandle = requestAnimationFrame(step);
}

async function loadFrames(sceneId: string): Promise<void> {
  try {
    const result = await previewServer.frames(DEVICE, sceneId, CLIP_DURATION, FPS);
    frames = result.frames;
    startPlayback();
  } catch (err) {
    showError((err as Error).message);
  }
}

async function reload(): Promise<void> {
  showError(null);
  stopPlayback();
  try {
    const [sceneList, map] = await Promise.all([previewServer.scenes(), previewServer.coordinateMap(DEVICE)]);
    scenes = sceneList;
    positions = map.positions;

    sceneSelect.innerHTML = "";
    for (const scene of scenes) {
      const option = document.createElement("option");
      option.value = scene.id;
      option.textContent = scene.name;
      sceneSelect.appendChild(option);
    }

    if (scenes.length > 0) {
      sceneSelect.value = scenes[0].id;
      descriptionEl.textContent = scenes[0].description;
      await loadFrames(scenes[0].id);
    }
  } catch (err) {
    showError((err as Error).message);
  }
}

sceneSelect.addEventListener("change", async () => {
  const scene = scenes.find((s) => s.id === sceneSelect.value);
  descriptionEl.textContent = scene?.description ?? "";
  await loadFrames(sceneSelect.value);
});

reloadButton.addEventListener("click", () => {
  void reload();
});

window.addEventListener("resize", () => {
  resizeCanvasForDisplay();
});

window.addEventListener("DOMContentLoaded", () => {
  resizeCanvasForDisplay();
  void reload();
});
