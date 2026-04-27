import "./styles.css";
import type { MarkdownViewer, PublicEntry, PublicManifest } from "./markdown-viewer";

interface PublicRoom {
  workspace: {
    id: string;
    name: string;
  };
  publication: {
    enabled: boolean;
    updatedAt: string;
  };
}

interface AppState {
  rooms: PublicRoom[];
  manifest: PublicManifest | null;
  roomId: string | null;
  entryId: string | null;
  eventSource: EventSource | null;
  markdownViewer: MarkdownViewer | null;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root.");
}

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark"></span>
        <div>
          <strong>Rolay</strong>
          <span>public notes</span>
        </div>
      </div>
      <label class="room-picker">
        <span>Опубликованная комната</span>
        <select id="roomSelect"></select>
      </label>
      <nav id="entryList" class="entry-list" aria-label="Файлы комнаты"></nav>
    </aside>
    <main class="reader">
      <header class="reader-header">
        <div>
          <p id="eyebrow" class="eyebrow">read-only</p>
          <h1 id="title">Загрузка</h1>
        </div>
        <div id="presence" class="presence"></div>
      </header>
      <section id="status" class="status">Подключаюсь к опубликованным комнатам...</section>
      <section id="editorHost" class="document-host"></section>
      <section id="drawingHost" class="drawing-host hidden"></section>
    </main>
  </div>
`;

const roomSelect = document.querySelector<HTMLSelectElement>("#roomSelect")!;
const entryList = document.querySelector<HTMLElement>("#entryList")!;
const title = document.querySelector<HTMLElement>("#title")!;
const eyebrow = document.querySelector<HTMLElement>("#eyebrow")!;
const status = document.querySelector<HTMLElement>("#status")!;
const editorHost = document.querySelector<HTMLElement>("#editorHost")!;
const drawingHost = document.querySelector<HTMLElement>("#drawingHost")!;
const presence = document.querySelector<HTMLElement>("#presence")!;

const state: AppState = {
  rooms: [],
  manifest: null,
  roomId: null,
  entryId: null,
  eventSource: null,
  markdownViewer: null
};

function cookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function loadRooms(): Promise<void> {
  const payload = await fetchJson<{ rooms: PublicRoom[] }>("/public/api/rooms");
  state.rooms = payload.rooms;
  renderRooms();

  if (state.rooms.length === 0) {
    showEmpty("Пока нет опубликованных комнат.");
    return;
  }

  const savedRoomId = cookie("rolay_public_room");
  const nextRoom =
    state.rooms.find((room) => room.workspace.id === savedRoomId) ?? state.rooms[0]!;
  await selectRoom(nextRoom.workspace.id);
}

async function selectRoom(workspaceId: string): Promise<void> {
  cleanupLiveDocument();
  state.roomId = workspaceId;
  setCookie("rolay_public_room", workspaceId);
  roomSelect.value = workspaceId;
  status.textContent = "Загружаю структуру комнаты...";
  const manifest = await fetchJson<PublicManifest>(
    `/public/api/rooms/${encodeURIComponent(workspaceId)}/manifest`
  );
  state.manifest = manifest;
  renderEntries();
  openEventStream(manifest);

  const savedEntryId = cookie("rolay_public_entry");
  const entry =
    manifest.entries.find(
      (candidate) =>
        candidate.id === savedEntryId &&
        (candidate.kind === "markdown" || candidate.kind === "excalidraw")
    ) ??
    manifest.entries.find((candidate) => candidate.kind === "markdown") ??
    manifest.entries.find((candidate) => candidate.kind === "excalidraw");

  if (!entry) {
    showEmpty("В этой комнате пока нет публичных заметок.");
    return;
  }

  await selectEntry(entry.id);
}

async function refreshManifest(): Promise<void> {
  if (!state.roomId) {
    return;
  }

  const manifest = await fetchJson<PublicManifest>(
    `/public/api/rooms/${encodeURIComponent(state.roomId)}/manifest`
  );
  state.manifest = manifest;
  renderEntries();
  state.markdownViewer?.updateAssets(manifest.assets);
  if (state.entryId && !manifest.entries.some((entry) => entry.id === state.entryId)) {
    const fallback = manifest.entries.find(
      (entry) => entry.kind === "markdown" || entry.kind === "excalidraw"
    );
    if (fallback) {
      await selectEntry(fallback.id);
    } else {
      showEmpty("В этой комнате больше нет публичных заметок.");
    }
  }
}

async function selectEntry(entryId: string): Promise<void> {
  const entry = state.manifest?.entries.find((candidate) => candidate.id === entryId);
  if (!entry || !state.roomId || !state.manifest) {
    return;
  }

  cleanupLiveDocument();
  state.entryId = entryId;
  setCookie("rolay_public_entry", entryId);
  renderEntries();
  title.textContent = filename(entry.path);
  eyebrow.textContent = entry.path;
  status.textContent = "";
  status.classList.add("hidden");

  if (entry.kind === "markdown") {
    await openMarkdown(entry, state.manifest);
    return;
  }

  await openDrawing(entry);
}

async function openMarkdown(entry: PublicEntry, manifest: PublicManifest): Promise<void> {
  drawingHost.classList.add("hidden");
  editorHost.classList.remove("hidden");
  editorHost.innerHTML = `<div class="skeleton">Загружаю заметку...</div>`;
  presence.innerHTML = "";

  const { openMarkdownViewer } = await import("./markdown-viewer");
  state.markdownViewer = await openMarkdownViewer({
    entry,
    manifest,
    editorHost,
    presence
  });
}

async function openDrawing(entry: PublicEntry): Promise<void> {
  editorHost.classList.add("hidden");
  drawingHost.classList.remove("hidden");
  drawingHost.innerHTML = `<div class="skeleton">Загружаю Excalidraw...</div>`;
  presence.innerHTML = "";

  if (!state.roomId || !entry.blob) {
    drawingHost.innerHTML = `<div class="empty">У этого рисунка пока нет опубликованного содержимого.</div>`;
    return;
  }

  const response = await fetch(
    `/public/api/rooms/${encodeURIComponent(state.roomId)}` +
      `/files/${encodeURIComponent(entry.id)}/blob/content` +
      `?hash=${encodeURIComponent(entry.blob.hash)}`
  );
  if (!response.ok) {
    throw new Error(`Could not load drawing: ${response.status}`);
  }

  const raw = await response.text();
  const { renderDrawing } = await import("./drawing-viewer");
  await renderDrawing(raw, drawingHost);
}

function openEventStream(manifest: PublicManifest): void {
  state.eventSource?.close();
  const source = new EventSource(
    `/public/api/rooms/${encodeURIComponent(manifest.workspace.id)}/events?cursor=${manifest.cursor}`
  );
  source.addEventListener("room.publication.updated", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      publication?: { enabled?: boolean };
    };
    if (payload.publication?.enabled === false) {
      source.close();
      showEmpty("Эта комната больше не опубликована.");
      return;
    }
    void refreshManifest();
  });
  for (const type of [
    "tree.entry.created",
    "tree.entry.updated",
    "tree.entry.deleted",
    "tree.entry.restored",
    "blob.revision.committed"
  ]) {
    source.addEventListener(type, () => {
      void refreshManifest();
    });
  }
  state.eventSource = source;
}

function renderRooms(): void {
  roomSelect.innerHTML = "";
  for (const room of state.rooms) {
    const option = document.createElement("option");
    option.value = room.workspace.id;
    option.textContent = room.workspace.name;
    roomSelect.append(option);
  }
}

function renderEntries(): void {
  const manifest = state.manifest;
  entryList.innerHTML = "";
  if (!manifest) {
    return;
  }

  for (const entry of manifest.entries) {
    if (entry.kind === "folder") {
      continue;
    }
    const button = document.createElement("button");
    button.className = `entry ${entry.id === state.entryId ? "active" : ""}`;
    button.type = "button";
    button.style.paddingLeft = `${12 + depth(entry.path) * 14}px`;
    button.innerHTML = `
      <span class="entry-kind">${entry.kind === "markdown" ? "md" : "draw"}</span>
      <span>${escapeHtml(filename(entry.path))}</span>
    `;
    button.addEventListener("click", () => {
      void selectEntry(entry.id);
    });
    entryList.append(button);
  }
}

function showEmpty(message: string): void {
  cleanupLiveDocument();
  title.textContent = "Rolay Public Notes";
  eyebrow.textContent = "read-only";
  status.textContent = message;
  status.classList.remove("hidden");
  editorHost.innerHTML = "";
  drawingHost.innerHTML = "";
  drawingHost.classList.add("hidden");
  presence.innerHTML = "";
}

function cleanupLiveDocument(): void {
  state.markdownViewer?.destroy();
  state.markdownViewer = null;
}

function filename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function depth(filePath: string): number {
  return Math.max(0, filePath.split("/").length - 1);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

roomSelect.addEventListener("change", () => {
  void selectRoom(roomSelect.value);
});

loadRooms().catch((error) => {
  showEmpty(`Не получилось загрузить публичные конспекты: ${error instanceof Error ? error.message : String(error)}`);
});
