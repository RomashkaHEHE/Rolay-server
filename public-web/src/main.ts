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

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  files: PublicEntry[];
  noteEntry?: PublicEntry;
}

interface AppState {
  rooms: PublicRoom[];
  manifest: PublicManifest | null;
  roomId: string | null;
  entryId: string | null;
  expandedFolders: Set<string>;
  anonymousViewerCounts: Map<string, number>;
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
  expandedFolders: new Set(),
  anonymousViewerCounts: new Map(),
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
  state.expandedFolders = loadExpandedFolders(workspaceId);
  state.anonymousViewerCounts = new Map();
  setCookie("rolay_public_room", workspaceId);
  roomSelect.value = workspaceId;
  status.textContent = "Загружаю структуру комнаты...";
  status.classList.remove("hidden");
  const manifest = await fetchJson<PublicManifest>(
    `/public/api/rooms/${encodeURIComponent(workspaceId)}/manifest`
  );
  state.manifest = manifest;
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
    renderEntries();
    showEmpty("В этой комнате пока нет публичных заметок.");
    return;
  }

  renderEntries();
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
  if (state.entryId) {
    const active = manifest.entries.find((entry) => entry.id === state.entryId);
    if (active) {
      title.textContent = filename(active.path);
      eyebrow.textContent = breadcrumb(active.path);
    }
  }
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
  eyebrow.textContent = breadcrumb(entry.path);
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
    presence,
    getAnonymousViewerCount: () => anonymousViewerCount(entry.id)
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
  source.addEventListener("public.note-viewers.snapshot", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      notes?: Array<{ entryId?: unknown; anonymousViewerCount?: unknown }>;
    };
    state.anonymousViewerCounts = new Map();
    for (const note of payload.notes ?? []) {
      if (typeof note.entryId === "string" && typeof note.anonymousViewerCount === "number") {
        state.anonymousViewerCounts.set(note.entryId, note.anonymousViewerCount);
      }
    }
    renderEntries();
    updateActiveAnonymousViewerCount();
  });
  source.addEventListener("public.note-viewers.updated", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      entryId?: unknown;
      anonymousViewerCount?: unknown;
    };
    if (typeof payload.entryId !== "string" || typeof payload.anonymousViewerCount !== "number") {
      return;
    }
    if (payload.anonymousViewerCount > 0) {
      state.anonymousViewerCounts.set(payload.entryId, payload.anonymousViewerCount);
    } else {
      state.anonymousViewerCounts.delete(payload.entryId);
    }
    renderEntries();
    updateActiveAnonymousViewerCount();
  });
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

  const root = buildTree(manifest.entries);
  renderTreeNode(root, 0);
}

function renderTreeNode(node: TreeNode, level: number): void {
  const folders = [...node.folders.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ru")
  );
  const files = [...node.files].sort((left, right) =>
    filename(left.path).localeCompare(filename(right.path), "ru")
  );

  for (const folder of folders) {
    const canExpand = hasVisibleChildren(folder);
    const expanded = state.expandedFolders.has(folder.path);
    const collapsed = !expanded;
    const button = document.createElement("button");
    button.className = `entry folder-entry ${folder.noteEntry?.id === state.entryId ? "active" : ""}`;
    button.type = "button";
    button.style.paddingLeft = `${10 + level * 16}px`;
    if (canExpand) {
      button.setAttribute("aria-expanded", String(expanded));
    }
    button.innerHTML = `
      <span class="folder-caret ${canExpand ? (collapsed ? "folder-caret-collapsed" : "folder-caret-expanded") : "folder-caret-static"}" aria-hidden="true"></span>
      <span class="folder-glyph ${folder.noteEntry ? "folder-glyph-note" : ""}" aria-hidden="true"></span>
      <span class="entry-label">${escapeHtml(folder.name)}</span>
      ${folder.noteEntry ? '<span class="folder-note-dot" title="Folder note"></span>' : ""}
    `;
    button.addEventListener("click", (event) => {
      if ((event.target as HTMLElement | null)?.closest(".folder-caret")) {
        if (canExpand) {
          toggleFolder(folder.path);
        }
        return;
      }
      if (folder.noteEntry) {
        void selectEntry(folder.noteEntry.id);
        return;
      }
      if (canExpand) {
        toggleFolder(folder.path);
      }
    });
    entryList.append(button);

    if (expanded && canExpand) {
      renderTreeNode(folder, level + 1);
    }
  }

  for (const file of files.filter((file) => file.id !== node.noteEntry?.id)) {
    const button = document.createElement("button");
    button.className = `entry file-entry ${file.id === state.entryId ? "active" : ""}`;
    button.type = "button";
    button.style.paddingLeft = `${32 + level * 16}px`;
    button.innerHTML = `
      <span class="file-glyph ${file.kind === "excalidraw" ? "file-glyph-drawing" : ""}" aria-hidden="true"></span>
      <span class="entry-label">${escapeHtml(displayFilename(file.path))}</span>
      ${anonymousViewerCount(file.id) > 0 ? `<span class="entry-viewers">${anonymousViewerCount(file.id)}</span>` : ""}
    `;
    button.addEventListener("click", () => {
      void selectEntry(file.id);
    });
    entryList.append(button);
  }
}

function hasVisibleChildren(folder: TreeNode): boolean {
  return (
    folder.folders.size > 0 ||
    folder.files.some((file) => file.id !== folder.noteEntry?.id)
  );
}

function buildTree(entries: PublicEntry[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    folders: new Map(),
    files: []
  };

  for (const entry of entries) {
    const parts = normalizePath(entry.path).split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    if (entry.kind === "folder") {
      ensureFolder(root, parts);
      continue;
    }

    let parent = root;
    for (const segment of parts.slice(0, -1)) {
      parent = ensureFolder(parent, [segment]);
    }
    parent.files.push(entry);
  }

  assignFolderNotes(root);
  return root;
}

function ensureFolder(root: TreeNode, segments: string[]): TreeNode {
  let cursor = root;
  for (const segment of segments) {
    const path = cursor.path ? `${cursor.path}/${segment}` : segment;
    let next = cursor.folders.get(segment);
    if (!next) {
      next = {
        name: segment,
        path,
        folders: new Map(),
        files: []
      };
      cursor.folders.set(segment, next);
    }
    cursor = next;
  }
  return cursor;
}

function assignFolderNotes(node: TreeNode): void {
  for (const folder of node.folders.values()) {
    const expectedPath = normalizePath(`${folder.path}/${folder.name}.md`).toLowerCase();
    const noteEntry = folder.files.find(
      (file) => file.kind === "markdown" && normalizePath(file.path).toLowerCase() === expectedPath
    );
    if (noteEntry) {
      folder.noteEntry = noteEntry;
    }
    assignFolderNotes(folder);
  }
}

function toggleFolder(folderPath: string): void {
  if (state.expandedFolders.has(folderPath)) {
    state.expandedFolders.delete(folderPath);
  } else {
    state.expandedFolders.add(folderPath);
  }
  saveExpandedFolders();
  renderEntries();
}

function loadExpandedFolders(workspaceId: string): Set<string> {
  try {
    const raw = cookie(`rolay_public_expanded_${workspaceId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function saveExpandedFolders(): void {
  if (!state.roomId) {
    return;
  }
  setCookie(`rolay_public_expanded_${state.roomId}`, JSON.stringify([...state.expandedFolders]));
}

function anonymousViewerCount(entryId: string): number {
  return state.anonymousViewerCounts.get(entryId) ?? 0;
}

function updateActiveAnonymousViewerCount(): void {
  state.markdownViewer?.updateAnonymousViewerCount(
    state.entryId ? anonymousViewerCount(state.entryId) : 0
  );
}

function breadcrumb(filePath: string): string {
  return normalizePath(filePath).split("/").join(" / ");
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

function displayFilename(filePath: string): string {
  return filename(filePath)
    .replace(/\.excalidraw\.md$/i, "")
    .replace(/\.md$/i, "");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
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
  showEmpty(
    `Не получилось загрузить публичные конспекты: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
});
