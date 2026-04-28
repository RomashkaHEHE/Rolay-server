import { exportToSvg, restoreAppState, restoreElements } from "@excalidraw/excalidraw";
import { decompressFromBase64 } from "lz-string";

interface ExcalidrawScene {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

const DARK_DRAWING_BACKGROUND = "#151821";
const DEFAULT_DRAWING_BACKGROUND = "#f8f4e8";
const MIN_DRAWING_SCALE = 0.25;
const MAX_DRAWING_SCALE = 4;
const DRAWING_SCALE_STEP = 1.2;

export async function renderDrawing(raw: string, drawingHost: HTMLElement): Promise<void> {
  const scene = parseExcalidrawScene(raw);
  if (!scene) {
    drawingHost.innerHTML = `<div class="drawing-error"></div><pre class="drawing-raw"></pre>`;
    drawingHost.querySelector(".drawing-error")!.textContent =
      isObsidianExcalidraw(raw)
        ? "Excalidraw scene marker was found, but the drawing JSON block could not be parsed."
        : "This file does not look like an Excalidraw scene.";
    drawingHost.querySelector("pre")!.textContent = raw;
    return;
  }

  try {
    await renderOfficialExcalidraw(scene, drawingHost);
    return;
  } catch {
    renderFallbackCanvas(scene, drawingHost);
  }
}

async function renderOfficialExcalidraw(
  scene: ExcalidrawScene,
  drawingHost: HTMLElement
): Promise<void> {
  const interactive = shouldUseInteractiveViewport(drawingHost);
  const elements = restoreElements((scene.elements ?? []) as never[], null);
  const sceneTheme = scene.appState?.theme === "dark" ? "dark" : "light";
  const sceneBackground =
    typeof scene.appState?.viewBackgroundColor === "string"
      ? scene.appState.viewBackgroundColor
      : sceneTheme === "dark"
        ? DARK_DRAWING_BACKGROUND
        : DEFAULT_DRAWING_BACKGROUND;
  const appState = restoreAppState(
    {
      ...(scene.appState ?? {}),
      theme: sceneTheme,
      viewBackgroundColor: sceneBackground,
      exportBackground: true,
      exportWithDarkMode: sceneTheme === "dark"
    },
    null
  );
  const svg = await exportToSvg({
    elements,
    appState,
    files: (scene.files ?? {}) as never,
    exportPadding: 28,
    renderEmbeddables: true
  });
  svg.classList.add("drawing-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Excalidraw drawing");
  drawingHost.innerHTML = "";
  if (interactive) {
    mountInteractiveDrawing(drawingHost, svg);
  } else {
    drawingHost.append(svg);
  }
}

function renderFallbackCanvas(scene: ExcalidrawScene, drawingHost: HTMLElement): void {
  const interactive = shouldUseInteractiveViewport(drawingHost);
  const canvas = document.createElement("canvas");
  canvas.className = "drawing-canvas";
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  const elements = Array.isArray(scene.elements) ? scene.elements : [];
  const bounds = drawingBounds(elements);
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(720, bounds.width + 96);
  const height = Math.max(420, bounds.height + 96);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = DEFAULT_DRAWING_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.translate(48 - bounds.minX, 48 - bounds.minY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const element of elements) {
    drawElement(ctx, element as Record<string, unknown>);
  }

  drawingHost.innerHTML = "";
  if (interactive) {
    mountInteractiveDrawing(drawingHost, canvas);
  } else {
    drawingHost.append(canvas);
  }
}

function shouldUseInteractiveViewport(drawingHost: HTMLElement): boolean {
  return drawingHost.classList.contains("drawing-host");
}

function mountInteractiveDrawing(
  drawingHost: HTMLElement,
  surface: SVGSVGElement | HTMLCanvasElement
): void {
  let scale = 1;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startScrollLeft = 0;
  let startScrollTop = 0;

  drawingHost.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "drawing-shell";
  shell.innerHTML = `
    <div class="drawing-toolbar" aria-label="Масштаб рисунка">
      <button type="button" class="drawing-zoom-out" title="Уменьшить">−</button>
      <span class="drawing-zoom-label">100%</span>
      <button type="button" class="drawing-zoom-in" title="Увеличить">+</button>
      <button type="button" class="drawing-zoom-reset" title="Сбросить масштаб">Сброс</button>
    </div>
    <div class="drawing-viewport" tabindex="0" aria-label="Excalidraw drawing viewport">
      <div class="drawing-stage"></div>
    </div>
  `;

  const viewport = shell.querySelector<HTMLElement>(".drawing-viewport")!;
  const stage = shell.querySelector<HTMLElement>(".drawing-stage")!;
  const zoomOut = shell.querySelector<HTMLButtonElement>(".drawing-zoom-out")!;
  const zoomIn = shell.querySelector<HTMLButtonElement>(".drawing-zoom-in")!;
  const zoomReset = shell.querySelector<HTMLButtonElement>(".drawing-zoom-reset")!;
  const zoomLabel = shell.querySelector<HTMLElement>(".drawing-zoom-label")!;

  stage.append(surface);
  drawingHost.append(shell);

  const baseSize = measureDrawingSurface(surface);
  surface.style.width = `${baseSize.width}px`;
  surface.style.height = `${baseSize.height}px`;
  surface.style.maxWidth = "none";

  const applyScale = () => {
    stage.style.width = `${baseSize.width * scale}px`;
    stage.style.height = `${baseSize.height * scale}px`;
    surface.style.transform = `scale(${scale})`;
    surface.style.transformOrigin = "0 0";
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };

  const setScale = (nextScale: number, anchor?: { clientX: number; clientY: number }) => {
    const previousScale = scale;
    const normalized = clamp(nextScale, MIN_DRAWING_SCALE, MAX_DRAWING_SCALE);
    if (normalized === previousScale) {
      return;
    }

    if (!anchor) {
      scale = normalized;
      applyScale();
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const anchorX = anchor.clientX - rect.left;
    const anchorY = anchor.clientY - rect.top;
    const contentX = anchorX + viewport.scrollLeft;
    const contentY = anchorY + viewport.scrollTop;
    const ratio = normalized / previousScale;

    scale = normalized;
    applyScale();
    viewport.scrollLeft = contentX * ratio - anchorX;
    viewport.scrollTop = contentY * ratio - anchorY;
  };

  zoomOut.addEventListener("click", () => setScale(scale / DRAWING_SCALE_STEP));
  zoomIn.addEventListener("click", () => setScale(scale * DRAWING_SCALE_STEP));
  zoomReset.addEventListener("click", () => {
    setScale(1);
    viewport.scrollTo({ left: 0, top: 0, behavior: "smooth" });
  });

  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const direction = event.deltaY > 0 ? 1 / DRAWING_SCALE_STEP : DRAWING_SCALE_STEP;
      setScale(scale * direction, { clientX: event.clientX, clientY: event.clientY });
    },
    { passive: false }
  );

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    startScrollLeft = viewport.scrollLeft;
    startScrollTop = viewport.scrollTop;
    viewport.classList.add("drawing-viewport-panning");
    viewport.setPointerCapture(event.pointerId);
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    viewport.scrollLeft = startScrollLeft - (event.clientX - dragStartX);
    viewport.scrollTop = startScrollTop - (event.clientY - dragStartY);
  });

  const stopDragging = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    viewport.classList.remove("drawing-viewport-panning");
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  };
  viewport.addEventListener("pointerup", stopDragging);
  viewport.addEventListener("pointercancel", stopDragging);
  viewport.addEventListener("pointerleave", stopDragging);

  applyScale();
}

function measureDrawingSurface(surface: SVGSVGElement | HTMLCanvasElement): {
  width: number;
  height: number;
} {
  const rect = surface.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }

  if (surface instanceof SVGSVGElement && surface.viewBox.baseVal.width > 0) {
    return {
      width: surface.viewBox.baseVal.width,
      height: Math.max(surface.viewBox.baseVal.height, 1)
    };
  }

  return {
    width: Number.parseFloat(surface.getAttribute("width") ?? "") || 720,
    height: Number.parseFloat(surface.getAttribute("height") ?? "") || 420
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseExcalidrawScene(raw: string): ExcalidrawScene | null {
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      const scene = normalizeScene(parsed);
      if (scene) {
        return applyMarkdownTextElements(scene, raw);
      }
    } catch {
      continue;
    }
  }

  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];

  for (const match of raw.matchAll(/```compressed-json\s*\n([\s\S]*?)```/gi)) {
    const compressed = match[1]?.trim();
    if (!compressed) {
      continue;
    }

    const decompressed = decompressDrawingJson(compressed);
    if (decompressed) {
      candidates.push(decompressed);
    }
  }

  for (const match of raw.matchAll(/```(?:json|excalidraw|javascript|js)?\s*\n([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  const drawingSection = raw.match(/(?:^|\n)#\s*Drawing\s*\n([\s\S]*)/i)?.[1];
  if (drawingSection) {
    for (const match of drawingSection.matchAll(/```(?:json|excalidraw)?\s*\n([\s\S]*?)```/gi)) {
      if (match[1]?.trim()) {
        candidates.unshift(match[1].trim());
      }
    }
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  return [...new Set(candidates)];
}

function decompressDrawingJson(compressed: string): string | null {
  const cleaned = compressed.replace(/\s+/g, "");
  try {
    return decompressFromBase64(cleaned);
  } catch {
    return null;
  }
}

function normalizeScene(value: unknown): ExcalidrawScene | null {
  if (!isRecord(value)) {
    return null;
  }

  const direct = value as ExcalidrawScene;
  if (Array.isArray(direct.elements)) {
    return direct;
  }

  const nestedScene = isRecord(value.scene) ? (value.scene as ExcalidrawScene) : null;
  if (nestedScene && Array.isArray(nestedScene.elements)) {
    return nestedScene;
  }

  const exported = isRecord(value.excalidraw) ? (value.excalidraw as ExcalidrawScene) : null;
  if (exported && Array.isArray(exported.elements)) {
    return exported;
  }

  return null;
}

function applyMarkdownTextElements(scene: ExcalidrawScene, raw: string): ExcalidrawScene {
  const textElements = parseMarkdownTextElements(raw);
  if (textElements.size === 0 || !Array.isArray(scene.elements)) {
    return scene;
  }

  return {
    ...scene,
    elements: scene.elements.map((element) => {
      if (!isRecord(element) || element.type !== "text" || typeof element.id !== "string") {
        return element;
      }

      const text = textElements.get(element.id);
      if (text === undefined) {
        return element;
      }

      return {
        ...element,
        text,
        rawText: text,
        originalText: text
      };
    })
  };
}

function parseMarkdownTextElements(raw: string): Map<string, string> {
  const elements = new Map<string, string>();
  const sectionStart = raw.search(/(^|\n)##?\s*Text Elements\s*(\n|$)/i);
  if (sectionStart < 0) {
    return elements;
  }

  const section = raw.slice(sectionStart).replace(/^[\s\S]*?##?\s*Text Elements\s*\n/i, "");
  const sectionEnd = section.search(/(^|\n)##?\s*(Element Links|Embedded Files|Drawing)\s*(\n|$)/i);
  const body = sectionEnd >= 0 ? section.slice(0, sectionEnd) : section;
  const pattern = /([\s\S]*?)\s+\^([A-Za-z0-9_-]{8})\s*(?:\n{2,}|$)/g;
  for (const match of body.matchAll(pattern)) {
    const text = match[1]
      ?.replace(/^%%\*\*\*>>>text element-link:.*?<<<\*\*\*%%\s*/gm, "")
      .trim();
    const id = match[2]?.trim();
    if (id && text) {
      elements.set(id, text);
    }
  }

  return elements;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObsidianExcalidraw(raw: string): boolean {
  return /^---[\s\S]*?excalidraw-plugin:\s*parsed[\s\S]*?---/i.test(raw);
}

function drawingBounds(elements: unknown[]): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  let minX = 0;
  let minY = 0;
  let maxX = 640;
  let maxY = 360;
  for (const element of elements as Array<Record<string, unknown>>) {
    const x = Number(element.x ?? 0);
    const y = Number(element.y ?? 0);
    const width = Number(element.width ?? 0);
    const height = Number(element.height ?? 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + Math.max(width, 1));
    maxY = Math.max(maxY, y + Math.max(height, 1));
  }

  return {
    minX,
    minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

function drawElement(ctx: CanvasRenderingContext2D, element: Record<string, unknown>): void {
  const x = Number(element.x ?? 0);
  const y = Number(element.y ?? 0);
  const width = Number(element.width ?? 0);
  const height = Number(element.height ?? 0);
  const color = String(element.strokeColor ?? "#1e1e1e");
  ctx.strokeStyle = color === "transparent" ? "#f2ecd7" : color;
  ctx.fillStyle = String(element.backgroundColor ?? "transparent");
  ctx.lineWidth = Number(element.strokeWidth ?? 2);

  switch (element.type) {
    case "rectangle":
      fillAndStroke(ctx, () => ctx.rect(x, y, width, height));
      return;
    case "diamond":
      fillAndStroke(ctx, () => {
        ctx.moveTo(x + width / 2, y);
        ctx.lineTo(x + width, y + height / 2);
        ctx.lineTo(x + width / 2, y + height);
        ctx.lineTo(x, y + height / 2);
        ctx.closePath();
      });
      return;
    case "ellipse":
      fillAndStroke(ctx, () =>
        ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
      );
      return;
    case "text":
      ctx.fillStyle = color;
      ctx.font = `${Number(element.fontSize ?? 20)}px sans-serif`;
      ctx.fillText(String(element.text ?? ""), x, y + Number(element.fontSize ?? 20));
      return;
    case "line":
    case "arrow":
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + width, y + height);
      ctx.stroke();
      return;
    default:
      if (Array.isArray(element.points)) {
        ctx.beginPath();
        for (const [index, point] of (element.points as Array<[number, number]>).entries()) {
          const px = x + Number(point[0] ?? 0);
          const py = y + Number(point[1] ?? 0);
          if (index === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }
        ctx.stroke();
      }
  }
}

function fillAndStroke(ctx: CanvasRenderingContext2D, draw: () => void): void {
  ctx.beginPath();
  draw();
  if (ctx.fillStyle !== "transparent") {
    ctx.fill();
  }
  ctx.stroke();
}
