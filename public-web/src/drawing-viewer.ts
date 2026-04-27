import { exportToSvg, restoreAppState, restoreElements } from "@excalidraw/excalidraw";

interface ExcalidrawScene {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export async function renderDrawing(raw: string, drawingHost: HTMLElement): Promise<void> {
  const scene = parseExcalidrawScene(raw);
  if (!scene) {
    drawingHost.innerHTML = `<pre class="drawing-raw"></pre>`;
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
  const elements = restoreElements((scene.elements ?? []) as never[], null);
  const appState = restoreAppState(
    {
      ...(scene.appState ?? {}),
      theme: "light",
      viewBackgroundColor:
        typeof scene.appState?.viewBackgroundColor === "string"
          ? scene.appState.viewBackgroundColor
          : "#f8f4e8",
      exportBackground: true,
      exportWithDarkMode: false
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
  drawingHost.append(svg);
}

function renderFallbackCanvas(scene: ExcalidrawScene, drawingHost: HTMLElement): void {
  drawingHost.innerHTML = `<canvas class="drawing-canvas"></canvas>`;
  const canvas = drawingHost.querySelector<HTMLCanvasElement>("canvas")!;
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
  ctx.translate(48 - bounds.minX, 48 - bounds.minY);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const element of elements) {
    drawElement(ctx, element as Record<string, unknown>);
  }
}

function parseExcalidrawScene(raw: string): ExcalidrawScene | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  try {
    const parsed = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
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
  const color = String(element.strokeColor ?? "#f2ecd7");
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
