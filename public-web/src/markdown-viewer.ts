import { HocuspocusProvider } from "@hocuspocus/provider";
import katex from "katex";
import "katex/dist/katex.min.css";
import * as Y from "yjs";

export interface PublicAsset {
  entryId: string;
  path: string;
  hash: string;
  sizeBytes: number;
  mimeType: string;
  contentUrl: string;
}

export interface PublicEntry {
  id: string;
  path: string;
  kind: "folder" | "markdown" | "excalidraw";
  contentMode: "none" | "crdt" | "blob";
  entryVersion: number;
  docId?: string;
  blob?: {
    hash: string;
    sizeBytes: number;
    mimeType: string;
  };
  updatedAt: string;
}

export interface PublicManifest {
  workspace: {
    id: string;
    name: string;
  };
  publication: {
    enabled: boolean;
    updatedAt: string;
  };
  cursor: number;
  entries: PublicEntry[];
  assets: Record<string, PublicAsset>;
}

interface PublicCrdtToken {
  entryId: string;
  docId: string;
  wsUrl: string;
  token: string;
  readOnly: true;
}

export interface MarkdownViewer {
  updateAssets(assets: Record<string, PublicAsset>): void;
  destroy(): void;
}

interface RemoteViewer {
  label: string;
  color: string;
  hasSelection: boolean;
}

interface RenderContext {
  assets: Record<string, PublicAsset>;
}

export async function openMarkdownViewer(params: {
  entry: PublicEntry;
  manifest: PublicManifest;
  editorHost: HTMLElement;
  presence: HTMLElement;
}): Promise<MarkdownViewer> {
  params.editorHost.innerHTML = `<article class="markdown-preview" aria-live="polite"></article>`;
  params.presence.innerHTML = "";

  const document = new Y.Doc();
  const text = document.getText("content");
  let assets = params.manifest.assets;
  let destroyed = false;
  let renderToken = 0;
  let renderQueued = false;

  const render = async () => {
    if (destroyed) {
      return;
    }

    renderQueued = false;
    const currentToken = ++renderToken;
    const raw = text.toString();

    if (isObsidianExcalidraw(raw)) {
      params.editorHost.classList.add("document-host-drawing");
      params.editorHost.innerHTML = `<div class="document-drawing"></div>`;
      const drawing = params.editorHost.querySelector<HTMLElement>(".document-drawing")!;
      const { renderDrawing } = await import("./drawing-viewer");
      if (!destroyed && currentToken === renderToken) {
        await renderDrawing(raw, drawing);
      }
      return;
    }

    params.editorHost.classList.remove("document-host-drawing");
    let article = params.editorHost.querySelector<HTMLElement>(".markdown-preview");
    if (!article) {
      params.editorHost.innerHTML = `<article class="markdown-preview" aria-live="polite"></article>`;
      article = params.editorHost.querySelector<HTMLElement>(".markdown-preview")!;
    }
    article.replaceChildren(renderMarkdown(raw, { assets }));
  };

  const queueRender = () => {
    if (renderQueued || destroyed) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      void render();
    });
  };

  const token = await fetchJson<PublicCrdtToken>(
    `/public/api/rooms/${encodeURIComponent(params.manifest.workspace.id)}` +
      `/markdown/${encodeURIComponent(params.entry.id)}/crdt-token`,
    {
      method: "POST"
    }
  );
  const provider = new HocuspocusProvider({
    url: token.wsUrl,
    name: token.docId,
    document,
    token: token.token,
    onSynced: ({ state }) => {
      if (state) {
        queueRender();
        renderRemotePresence(provider, params.presence);
      }
    }
  });

  // Public viewers are read-only observers: they receive member awareness but never publish visitor
  // awareness back into the shared room.
  provider.awareness?.setLocalState(null);

  const textObserver = () => {
    queueRender();
  };
  text.observe(textObserver);

  const presenceObserver = () => {
    renderRemotePresence(provider, params.presence);
  };
  provider.awareness?.on("change", presenceObserver);
  provider.awareness?.on("update", presenceObserver);
  queueMicrotask(() => {
    queueRender();
    presenceObserver();
  });

  return {
    updateAssets(nextAssets) {
      assets = nextAssets;
      queueRender();
    },
    destroy() {
      destroyed = true;
      provider.awareness?.off("change", presenceObserver);
      provider.awareness?.off("update", presenceObserver);
      text.unobserve(textObserver);
      provider.destroy();
      document.destroy();
      params.editorHost.classList.remove("document-host-drawing");
    }
  };
}

function renderMarkdown(raw: string, context: RenderContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const content = stripFrontmatter(normalizeLines(raw));
  renderBlocks(content.split("\n"), context, fragment);
  if (!fragment.hasChildNodes()) {
    const empty = document.createElement("p");
    empty.className = "markdown-empty";
    empty.textContent = "В заметке пока нет текста.";
    fragment.append(empty);
  }
  return fragment;
}

function renderBlocks(
  lines: string[],
  context: RenderContext,
  target: ParentNode
): void {
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index++;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const block = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) {
        code.dataset.language = fence[1];
      }
      index++;
      const body: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index++;
      }
      if (index < lines.length) {
        index++;
      }
      code.textContent = body.join("\n");
      block.append(code);
      target.appendChild(block);
      continue;
    }

    const displayMath = readDisplayMath(lines, index);
    if (displayMath) {
      const block = document.createElement("div");
      block.className = "math-block";
      renderKatex(displayMath.expression, true, block);
      target.appendChild(block);
      index = displayMath.nextIndex;
      continue;
    }

    const callout = readCallout(lines, index);
    if (callout) {
      target.appendChild(renderCallout(callout.type, callout.title, callout.body, context));
      index = callout.nextIndex;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index++;
      }
      const quote = document.createElement("blockquote");
      renderBlocks(quoteLines, context, quote);
      target.appendChild(quote);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      const element = document.createElement(`h${level}`);
      element.innerHTML = renderInline(heading[2]!, context);
      target.appendChild(element);
      index++;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      target.appendChild(document.createElement("hr"));
      index++;
      continue;
    }

    const list = readList(lines, index);
    if (list) {
      target.appendChild(renderList(list.ordered, list.items, context));
      index = list.nextIndex;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      target.appendChild(renderTable(table.rows, context));
      index = table.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !startsBlock(lines, index)
    ) {
      paragraph.push(lines[index] ?? "");
      index++;
    }
    const p = document.createElement("p");
    p.innerHTML = renderInline(paragraph.join(" "), context);
    target.appendChild(p);
  }
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*(?:[-+*]\s+|\d+[.)]\s+)/.test(line) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line) ||
    Boolean(readDisplayMath(lines, index)) ||
    Boolean(readTable(lines, index))
  );
}

function readDisplayMath(
  lines: string[],
  index: number
): { expression: string; nextIndex: number } | null {
  const line = lines[index]?.trim() ?? "";
  const singleDollar = line.match(/^\$\$([\s\S]+)\$\$$/);
  if (singleDollar) {
    return {
      expression: singleDollar[1]!.trim(),
      nextIndex: index + 1
    };
  }

  const singleBracket = line.match(/^\\\[([\s\S]+)\\\]$/);
  if (singleBracket) {
    return {
      expression: singleBracket[1]!.trim(),
      nextIndex: index + 1
    };
  }

  if (line !== "$$" && line !== "\\[") {
    return null;
  }

  const closing = line === "$$" ? "$$" : "\\]";
  const body: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && (lines[cursor]?.trim() ?? "") !== closing) {
    body.push(lines[cursor] ?? "");
    cursor++;
  }
  if (cursor >= lines.length) {
    return null;
  }

  return {
    expression: body.join("\n").trim(),
    nextIndex: cursor + 1
  };
}

function readCallout(
  lines: string[],
  index: number
): { type: string; title: string; body: string[]; nextIndex: number } | null {
  const first = lines[index] ?? "";
  const match = first.match(/^>\s*\[!([A-Za-z0-9_-]+)](?:[+-])?\s*(.*)$/);
  if (!match) {
    return null;
  }

  const body: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && /^>\s?/.test(lines[cursor] ?? "")) {
    body.push((lines[cursor] ?? "").replace(/^>\s?/, ""));
    cursor++;
  }

  return {
    type: match[1]!.toLowerCase(),
    title: match[2]?.trim() || calloutTitle(match[1]!),
    body,
    nextIndex: cursor
  };
}

function renderCallout(
  type: string,
  title: string,
  body: string[],
  context: RenderContext
): HTMLElement {
  const callout = document.createElement("aside");
  callout.className = `callout callout-${safeClassName(type)}`;

  const heading = document.createElement("div");
  heading.className = "callout-title";
  heading.innerHTML = `<span class="callout-icon">${calloutIcon(type)}</span><span>${renderInline(title, context)}</span>`;
  callout.append(heading);

  const content = document.createElement("div");
  content.className = "callout-content";
  renderBlocks(body, context, content);
  callout.append(content);
  return callout;
}

function readList(
  lines: string[],
  index: number
): { ordered: boolean; items: string[]; nextIndex: number } | null {
  const first = lines[index] ?? "";
  const ordered = /^\s*\d+[.)]\s+/.test(first);
  const unordered = /^\s*[-+*]\s+/.test(first);
  if (!ordered && !unordered) {
    return null;
  }

  const items: string[] = [];
  let cursor = index;
  const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-+*]\s+/;
  while (cursor < lines.length && pattern.test(lines[cursor] ?? "")) {
    items.push((lines[cursor] ?? "").replace(pattern, ""));
    cursor++;
  }
  return {
    ordered,
    items,
    nextIndex: cursor
  };
}

function renderList(ordered: boolean, items: string[], context: RenderContext): HTMLElement {
  const list = document.createElement(ordered ? "ol" : "ul");
  for (const item of items) {
    const li = document.createElement("li");
    li.innerHTML = renderInline(item, context);
    list.append(li);
  }
  return list;
}

function readTable(
  lines: string[],
  index: number
): { rows: string[][]; nextIndex: number } | null {
  const header = lines[index] ?? "";
  const separator = lines[index + 1] ?? "";
  if (!header.includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) {
    return null;
  }

  const rows: string[][] = [splitTableRow(header)];
  let cursor = index + 2;
  while (cursor < lines.length && (lines[cursor] ?? "").includes("|")) {
    rows.push(splitTableRow(lines[cursor] ?? ""));
    cursor++;
  }

  return {
    rows,
    nextIndex: cursor
  };
}

function renderTable(rows: string[][], context: RenderContext): HTMLElement {
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const body = document.createElement("tbody");
  const [header, ...rest] = rows;

  if (header) {
    const tr = document.createElement("tr");
    for (const cell of header) {
      const th = document.createElement("th");
      th.innerHTML = renderInline(cell.trim(), context);
      tr.append(th);
    }
    head.append(tr);
  }

  for (const row of rest) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.innerHTML = renderInline(cell.trim(), context);
      tr.append(td);
    }
    body.append(tr);
  }

  table.append(head, body);
  return table;
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
}

function renderInline(raw: string, context: RenderContext): string {
  const placeholders: string[] = [];
  const reserve = (html: string) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let value = raw;

  value = value.replace(/!\[\[([^\]]+)]]|!\[([^\]]*)]\(([^)]+)\)/g, (match, wikiTarget, alt, mdTarget) => {
    const target = String(wikiTarget ?? mdTarget ?? "").trim();
    const asset = resolveAsset(context.assets, target);
    if (!asset) {
      return match;
    }
    const caption = String(alt ?? asset.path);
    return reserve(renderImage(asset, caption));
  });

  value = value.replace(/`([^`]+)`/g, (_match, code) => {
    return reserve(`<code>${escapeHtml(String(code))}</code>`);
  });

  value = value.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression) => {
    return reserve(renderKatexHtml(String(expression), true));
  });
  value = value.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expression) => {
    return reserve(renderKatexHtml(String(expression), true));
  });
  value = value.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expression) => {
    return reserve(renderKatexHtml(String(expression), false));
  });
  value = value.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (_match, prefix, expression) => {
    return `${prefix}${reserve(renderKatexHtml(String(expression), false))}`;
  });

  let html = escapeHtml(value);
  html = html.replace(
    /&lt;font\s+color=&quot;([#a-zA-Z0-9(),.\s%-]+)&quot;&gt;([\s\S]*?)&lt;\/font&gt;/gi,
    (_match, color, body) => {
      const safeColor = sanitizeCssColor(String(color));
      return safeColor ? `<span style="color: ${safeColor}">${body}</span>` : body;
    }
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  html = html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, target, label) => {
    const text = String(label ?? target);
    return `<span class="internal-link">${text}</span>`;
  });
  html = html.replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g, (_match, label, href) => {
    return `<a href="${escapeAttribute(String(href))}" target="_blank" rel="noreferrer noopener">${label}</a>`;
  });
  html = html.replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  html = html.replace(/&lt;(sub|sup)&gt;([\s\S]*?)&lt;\/\1&gt;/gi, "<$1>$2</$1>");

  for (const [index, replacement] of placeholders.entries()) {
    html = html.replaceAll(`\u0000${index}\u0000`, replacement);
  }

  return html;
}

function renderImage(asset: PublicAsset, caption: string): string {
  return [
    `<figure class="note-image">`,
    `<img loading="lazy" decoding="async" src="${escapeAttribute(asset.contentUrl)}" alt="${escapeAttribute(caption)}">`,
    `<figcaption>${escapeHtml(asset.path)}</figcaption>`,
    `</figure>`
  ].join("");
}

function renderKatexHtml(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false
    });
  } catch {
    return escapeHtml(expression);
  }
}

function renderKatex(expression: string, displayMode: boolean, target: HTMLElement): void {
  try {
    katex.render(expression, target, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false
    });
  } catch {
    target.textContent = expression;
  }
}

function renderRemotePresence(provider: HocuspocusProvider, presence: HTMLElement): void {
  const awareness = provider.awareness;
  if (!awareness) {
    presence.innerHTML = "";
    return;
  }

  const viewers: RemoteViewer[] = [];
  for (const value of awareness.getStates().values()) {
    const record = value as Record<string, unknown>;
    const user = extractUser(record);
    if (!user) {
      continue;
    }

    viewers.push({
      ...user,
      hasSelection: Boolean(extractSelection(record))
    });
  }

  presence.innerHTML = "";
  for (const viewer of viewers) {
    const chip = document.createElement("span");
    chip.className = `presence-chip ${viewer.hasSelection ? "has-selection" : ""}`;
    chip.style.borderColor = viewer.color;
    chip.textContent = viewer.label;
    presence.append(chip);
  }
}

function extractUser(record: Record<string, unknown>): { label: string; color: string } | null {
  const user = asRecord(record.user);
  if (!user) {
    return null;
  }

  const label = firstString(user.displayName, user.name, user.username, user.id, user.userId);
  if (!label) {
    return null;
  }

  return {
    label,
    color: firstString(user.color, record.color) ?? "#d8a657"
  };
}

function extractSelection(
  record: Record<string, unknown>
): { anchor: number; head: number } | null {
  const viewer = asRecord(record.viewer);
  const candidates = [
    record.selection,
    record.cursor,
    record.caret,
    viewer?.selection,
    viewer?.cursor,
    viewer
  ];

  for (const candidate of candidates) {
    const selection = toSelection(candidate);
    if (selection) {
      return selection;
    }
  }

  return null;
}

function toSelection(value: unknown): { anchor: number; head: number } | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const anchor = firstFiniteNumber(record.anchor, record.from, record.position, record.pos);
  const head = firstFiniteNumber(record.head, record.to, record.anchor, record.from, record.position, record.pos);
  if (anchor === null || head === null) {
    return null;
  }

  return { anchor, head };
}

function resolveAsset(
  assets: Record<string, PublicAsset>,
  target: string
): PublicAsset | undefined {
  const clean = safeDecode(target)
    .replace(/^<|>$/g, "")
    .replace(/^\/+/, "")
    .split("#")[0]!
    .trim();
  return assets[clean] ?? assets[`/${clean}`] ?? assets[filename(clean)];
}

function isObsidianExcalidraw(raw: string): boolean {
  return (
    /^---[\s\S]*?excalidraw-plugin:\s*parsed[\s\S]*?---/i.test(raw) ||
    /(^|\n)#\s*Excalidraw Data(?:\n|$)/i.test(raw)
  );
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function normalizeLines(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

function calloutTitle(type: string): string {
  const normalized = type.toLowerCase();
  const titles: Record<string, string> = {
    note: "Note",
    info: "Info",
    tip: "Tip",
    warning: "Warning",
    danger: "Danger",
    important: "Important",
    question: "Question",
    success: "Success",
    failure: "Failure",
    bug: "Bug",
    example: "Example",
    quote: "Quote"
  };
  return titles[normalized] ?? type;
}

function calloutIcon(type: string): string {
  const normalized = type.toLowerCase();
  const icons: Record<string, string> = {
    note: "i",
    info: "i",
    tip: "*",
    warning: "!",
    danger: "!",
    important: "!",
    question: "?",
    success: "+",
    failure: "x",
    bug: "!",
    example: "#",
    quote: ">"
  };
  return icons[normalized] ?? "i";
}

function safeClassName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeCssColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-zA-Z]+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }

  return null;
}

function filename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
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

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
