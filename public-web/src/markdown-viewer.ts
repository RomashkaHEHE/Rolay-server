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
  updateAnonymousViewerCount(count: number): void;
  destroy(): void;
}

interface RemoteViewer {
  label: string;
  color: string;
  hasSelection: boolean;
  selection: { anchor: number; head: number } | null;
}

interface RenderContext {
  workspaceId: string;
  currentEntryPath: string;
  entries: PublicEntry[];
  assets: Record<string, PublicAsset>;
}

interface SourceMap {
  lineOffsets: number[];
  lineLengths: number[];
}

interface ListItem {
  lines: string[];
  source?: SourceMap;
}

interface ListResult {
  ordered: boolean;
  markerStyle: "bullet" | "dot" | "paren";
  start: number;
  items: ListItem[];
  nextIndex: number;
}

export async function openMarkdownViewer(params: {
  entry: PublicEntry;
  manifest: PublicManifest;
  editorHost: HTMLElement;
  presence: HTMLElement;
  getAnonymousViewerCount?: () => number;
}): Promise<MarkdownViewer> {
  params.editorHost.innerHTML = `<article class="markdown-preview" aria-live="polite"></article>`;
  params.presence.innerHTML = "";

  const document = new Y.Doc();
  const text = document.getText("content");
  let assets = params.manifest.assets;
  let anonymousViewerCount = params.getAnonymousViewerCount?.() ?? 0;
  let destroyed = false;
  let renderToken = 0;
  let renderQueued = false;
  let remoteViewers: RemoteViewer[] = [];

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
    const context = {
      workspaceId: params.manifest.workspace.id,
      currentEntryPath: params.entry.path,
      entries: params.manifest.entries,
      assets
    };
    const normalizedRaw = normalizeLines(raw);
    article.replaceChildren(renderMarkdown(normalizedRaw, context));
    await hydrateEmbeds(article, context);
    renderRemoteCursors(article, remoteViewers, normalizedRaw);
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
        remoteViewers = readRemoteViewers(provider);
        renderRemotePresence(remoteViewers, params.presence, anonymousViewerCount);
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
    remoteViewers = readRemoteViewers(provider);
    renderRemotePresence(remoteViewers, params.presence, anonymousViewerCount);
    queueRender();
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
    updateAnonymousViewerCount(count) {
      anonymousViewerCount = count;
      renderRemotePresence(remoteViewers, params.presence, anonymousViewerCount);
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
  const stripped = stripFrontmatterWithOffset(raw);
  const lines = stripped.content.split("\n");
  renderBlocks(lines, context, fragment, createSourceMap(lines, stripped.sourceOffset));
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
  target: ParentNode,
  source?: SourceMap
): void {
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index++;
      continue;
    }

    const blockStart = index;
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
      tagSource(block, source, blockStart, index, "code");
      code.textContent = body.join("\n");
      block.append(code);
      target.appendChild(block);
      continue;
    }

    const displayMath = readDisplayMath(lines, index);
    if (displayMath) {
      const block = document.createElement("div");
      block.className = "math-block";
      tagSource(block, source, index, displayMath.nextIndex, "math");
      renderKatex(displayMath.expression, true, block);
      target.appendChild(block);
      index = displayMath.nextIndex;
      continue;
    }

    const callout = readCallout(lines, index, source);
    if (callout) {
      const element = renderCallout(
        callout.type,
        callout.title,
        callout.body,
        context,
        callout.bodySource
      );
      tagSource(element, source, index, callout.nextIndex, "callout");
      target.appendChild(element);
      index = callout.nextIndex;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      const quoteOffsets: number[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        const quoteLine = lines[index] ?? "";
        const marker = quoteLine.match(/^>\s?/);
        quoteLines.push(quoteLine.replace(/^>\s?/, ""));
        if (source) {
          quoteOffsets.push((source.lineOffsets[index] ?? 0) + (marker?.[0].length ?? 0));
        }
        index++;
      }
      const quote = document.createElement("blockquote");
      tagSource(quote, source, blockStart, index, "quote");
      renderBlocks(
        quoteLines,
        context,
        quote,
        quoteOffsets.length > 0
          ? { lineOffsets: quoteOffsets, lineLengths: quoteLines.map((quoteLine) => quoteLine.length) }
          : undefined
      );
      target.appendChild(quote);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      const element = document.createElement(`h${level}`);
      tagSource(element, source, index, index + 1, "heading");
      element.innerHTML = renderInline(heading[2]!, context);
      target.appendChild(element);
      index++;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      const hr = document.createElement("hr");
      tagSource(hr, source, index, index + 1, "hr");
      target.appendChild(hr);
      index++;
      continue;
    }

    const list = readList(lines, index, source);
    if (list) {
      const element = renderList(list, context);
      tagSource(element, source, index, list.nextIndex, "list");
      target.appendChild(element);
      index = list.nextIndex;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      const element = renderTable(table.rows, context);
      tagSource(element, source, index, table.nextIndex, "table");
      target.appendChild(element);
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
    tagSource(p, source, blockStart, index, "paragraph");
    p.innerHTML = renderInline(paragraph.join("\n"), context);
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
  if (line.startsWith("$$")) {
    return readDelimitedDisplayMath(lines, index, "$$", "$$");
  }
  if (line.startsWith("\\[")) {
    return readDelimitedDisplayMath(lines, index, "\\[", "\\]");
  }

  return null;
}

function readDelimitedDisplayMath(
  lines: string[],
  index: number,
  opening: "$$" | "\\[",
  closing: "$$" | "\\]"
): { expression: string; nextIndex: number } | null {
  const firstLine = lines[index]?.trim() ?? "";
  if (!firstLine.startsWith(opening)) {
    return null;
  }

  const body: string[] = [];
  const afterOpening = firstLine.slice(opening.length);
  const sameLineClose = afterOpening.indexOf(closing);
  if (sameLineClose >= 0) {
    return {
      expression: afterOpening.slice(0, sameLineClose).trim(),
      nextIndex: index + 1
    };
  }

  if (afterOpening.trim() !== "") {
    body.push(afterOpening);
  }

  let cursor = index + 1;
  while (cursor < lines.length) {
    const current = lines[cursor] ?? "";
    const closeIndex = current.indexOf(closing);
    if (closeIndex >= 0) {
      const beforeClosing = current.slice(0, closeIndex);
      if (beforeClosing.trim() !== "") {
        body.push(beforeClosing);
      }
      return {
        expression: body.join("\n").trim(),
        nextIndex: cursor + 1
      };
    }

    body.push(current);
    cursor++;
  }

  return null;
}

function readCallout(
  lines: string[],
  index: number,
  source?: SourceMap
): {
  type: string;
  title: string;
  body: string[];
  bodySource?: SourceMap;
  fold: "+" | "-" | null;
  nextIndex: number;
} | null {
  const first = lines[index] ?? "";
  const match = first.match(/^>\s*\[!([A-Za-z0-9_-]+)]([+-])?\s*(.*)$/);
  if (!match) {
    return null;
  }

  const body: string[] = [];
  const bodyOffsets: number[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && /^>\s?/.test(lines[cursor] ?? "")) {
    const bodyLine = lines[cursor] ?? "";
    const marker = bodyLine.match(/^>\s?/);
    body.push(bodyLine.replace(/^>\s?/, ""));
    if (source) {
      bodyOffsets.push((source.lineOffsets[cursor] ?? 0) + (marker?.[0].length ?? 0));
    }
    cursor++;
  }

  return {
    type: match[1]!.toLowerCase(),
    fold: match[2] === "+" || match[2] === "-" ? match[2] : null,
    title: match[3]?.trim() || calloutTitle(match[1]!),
    body,
    ...(bodyOffsets.length > 0
      ? { bodySource: { lineOffsets: bodyOffsets, lineLengths: body.map((line) => line.length) } }
      : {}),
    nextIndex: cursor
  };
}

function renderCallout(
  type: string,
  title: string,
  body: string[],
  context: RenderContext,
  bodySource?: SourceMap
): HTMLElement {
  const canonicalType = calloutCanonicalType(type);
  const callout = document.createElement("aside");
  callout.className = `callout callout-${safeClassName(canonicalType)}`;
  callout.dataset.callout = canonicalType;

  const heading = document.createElement("div");
  heading.className = "callout-title";
  heading.innerHTML = `<span class="callout-icon">${calloutIcon(type)}</span><span>${renderInline(title, context)}</span>`;
  callout.append(heading);

  const content = document.createElement("div");
  content.className = "callout-content";
  renderBlocks(body, context, content, bodySource);
  callout.append(content);
  return callout;
}

function readList(
  lines: string[],
  index: number,
  source?: SourceMap
): ListResult | null {
  const first = parseListMarker(lines[index] ?? "");
  if (!first) {
    return null;
  }

  const items: ListItem[] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const marker = parseListMarker(lines[cursor] ?? "");
    if (
      !marker ||
      marker.ordered !== first.ordered ||
      marker.markerStyle !== first.markerStyle
    ) {
      break;
    }

    const itemLines = [marker.content];
    const itemOffsets =
      source ? [(source.lineOffsets[cursor] ?? 0) + marker.contentStart] : [];
    const itemLengths = [marker.content.length];
    cursor++;

    while (itemHasOpenDisplayMath(itemLines) && cursor < lines.length) {
      const continuation = lines[cursor] ?? "";
      itemLines.push(continuation);
      if (source) {
        itemOffsets.push(source.lineOffsets[cursor] ?? 0);
      }
      itemLengths.push(continuation.length);
      cursor++;
    }

    items.push({
      lines: itemLines,
      ...(itemOffsets.length > 0
        ? { source: { lineOffsets: itemOffsets, lineLengths: itemLengths } }
        : {})
    });
  }

  return {
    ordered: first.ordered,
    markerStyle: first.markerStyle,
    start: first.number ?? 1,
    items,
    nextIndex: cursor
  };
}

function renderList(result: ListResult, context: RenderContext): HTMLElement {
  const list = document.createElement(result.ordered ? "ol" : "ul");
  if (result.ordered && result.start !== 1) {
    list.setAttribute("start", String(result.start));
  }
  if (result.markerStyle === "paren") {
    list.classList.add("ordered-paren");
    list.style.setProperty("--list-start", String(result.start - 1));
  }

  for (const item of result.items) {
    const li = document.createElement("li");
    tagListItemSource(li, item);
    if (item.lines.length === 1 && !startsBlock(item.lines, 0)) {
      li.innerHTML = renderInline(item.lines[0] ?? "", context);
    } else {
      renderBlocks(item.lines, context, li, item.source);
    }
    list.append(li);
  }
  return list;
}

function parseListMarker(line: string): {
  ordered: boolean;
  markerStyle: "bullet" | "dot" | "paren";
  number?: number;
  content: string;
  contentStart: number;
} | null {
  const ordered = line.match(/^(\s*)(\d+)([.)])\s+([\s\S]*)$/);
  if (ordered) {
    return {
      ordered: true,
      markerStyle: ordered[3] === ")" ? "paren" : "dot",
      number: Number(ordered[2]),
      content: ordered[4] ?? "",
      contentStart: ordered[0].length - (ordered[4]?.length ?? 0)
    };
  }

  const unordered = line.match(/^(\s*)[-+*]\s+([\s\S]*)$/);
  if (!unordered) {
    return null;
  }

  return {
    ordered: false,
    markerStyle: "bullet",
    content: unordered[2] ?? "",
    contentStart: unordered[0].length - (unordered[2]?.length ?? 0)
  };
}

function itemHasOpenDisplayMath(lines: string[]): boolean {
  const first = lines[0]?.trim() ?? "";
  if (!first.startsWith("$$") && !first.startsWith("\\[")) {
    return false;
  }

  return !readDisplayMath(lines, 0);
}

function tagListItemSource(element: HTMLElement, item: ListItem): void {
  if (!item.source) {
    return;
  }

  const sourceStart = item.source.lineOffsets[0];
  if (sourceStart === undefined) {
    return;
  }

  element.dataset.sourceStart = String(sourceStart);
  element.dataset.sourceEnd = String(sourceEndForLine(item.source, item.lines.length));
  element.dataset.sourceKind = "list-item";
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

function tagSource(
  element: HTMLElement,
  source: SourceMap | undefined,
  startLine: number,
  endLine: number,
  kind: string
): void {
  if (!source) {
    return;
  }

  const sourceStart = source.lineOffsets[startLine];
  if (sourceStart === undefined) {
    return;
  }

  const sourceEnd = sourceEndForLine(source, endLine);
  element.dataset.sourceStart = String(sourceStart);
  element.dataset.sourceEnd = String(Math.max(sourceStart, sourceEnd));
  element.dataset.sourceKind = kind;
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
    const target = splitEmbedTarget(String(wikiTarget ?? mdTarget ?? "").trim()).target;
    const asset = resolveAsset(context.assets, target, context.currentEntryPath);
    if (!asset) {
      const entry = resolveEntry(context.entries, target, context.currentEntryPath);
      if (entry?.kind === "excalidraw" || entry?.kind === "markdown") {
        return reserve(renderEntryEmbedPlaceholder(entry, target));
      }
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
  html = html.replace(/\n/g, "<br>\n");

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

function renderEntryEmbedPlaceholder(entry: PublicEntry, target: string): string {
  return [
    `<figure class="note-embed note-embed-loading" data-entry-id="${escapeAttribute(entry.id)}">`,
    `<div class="note-embed-title">${escapeHtml(filename(entry.path))}</div>`,
    `<div class="note-embed-body">Loading ${escapeHtml(target)}...</div>`,
    `</figure>`
  ].join("");
}

async function hydrateEmbeds(article: HTMLElement, context: RenderContext): Promise<void> {
  const embeds = [...article.querySelectorAll<HTMLElement>(".note-embed[data-entry-id]")];
  await Promise.all(
    embeds.map(async (embed) => {
      const entryId = embed.dataset.entryId;
      const entry = context.entries.find((candidate) => candidate.id === entryId);
      if (!entry) {
        return;
      }

      try {
        const raw =
          entry.kind === "excalidraw" && entry.blob
            ? await fetchBlobText(context.workspaceId, entry)
            : await fetchMarkdownText(context.workspaceId, entry);

        if (!isObsidianExcalidraw(raw)) {
          embed.classList.remove("note-embed-loading");
          embed.classList.add("note-embed-unavailable");
          embed.querySelector(".note-embed-body")!.textContent =
            "Embedded markdown preview is not supported yet.";
          return;
        }

        embed.classList.remove("note-embed-loading");
        embed.classList.add("note-embed-drawing");
        const body = embed.querySelector<HTMLElement>(".note-embed-body")!;
        const { renderDrawing } = await import("./drawing-viewer");
        await renderDrawing(raw, body);
      } catch (error) {
        embed.classList.remove("note-embed-loading");
        embed.classList.add("note-embed-error");
        embed.querySelector(".note-embed-body")!.textContent =
          error instanceof Error ? error.message : "Could not load embedded drawing.";
      }
    })
  );
}

async function fetchBlobText(workspaceId: string, entry: PublicEntry): Promise<string> {
  if (!entry.blob) {
    throw new Error("Embedded drawing has no published blob.");
  }

  const response = await fetch(
    `/public/api/rooms/${encodeURIComponent(workspaceId)}` +
      `/files/${encodeURIComponent(entry.id)}/blob/content` +
      `?hash=${encodeURIComponent(entry.blob.hash)}`
  );
  if (!response.ok) {
    throw new Error(`Could not load embedded drawing: ${response.status}`);
  }
  return response.text();
}

async function fetchMarkdownText(workspaceId: string, entry: PublicEntry): Promise<string> {
  if (!entry.docId) {
    throw new Error("Embedded markdown note has no CRDT document.");
  }

  const token = await fetchJson<PublicCrdtToken>(
    `/public/api/rooms/${encodeURIComponent(workspaceId)}` +
      `/markdown/${encodeURIComponent(entry.id)}/crdt-token`,
    {
      method: "POST"
    }
  );
  const ydoc = new Y.Doc();
  const text = ydoc.getText("content");

  return new Promise<string>((resolve, reject) => {
    let provider: HocuspocusProvider | null = null;
    const timeout = window.setTimeout(() => {
      provider?.destroy();
      ydoc.destroy();
      reject(new Error("Timed out loading embedded drawing."));
    }, 5000);

    provider = new HocuspocusProvider({
      url: token.wsUrl,
      name: token.docId,
      document: ydoc,
      token: token.token,
      onSynced: ({ state }) => {
        if (!state) {
          return;
        }
        window.clearTimeout(timeout);
        const value = text.toString();
        provider?.awareness?.setLocalState(null);
        provider?.destroy();
        ydoc.destroy();
        resolve(value);
      }
    });
    provider.awareness?.setLocalState(null);
  });
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

function readRemoteViewers(provider: HocuspocusProvider): RemoteViewer[] {
  const awareness = provider.awareness;
  if (!awareness) {
    return [];
  }

  const viewers: RemoteViewer[] = [];
  for (const value of awareness.getStates().values()) {
    const record = value as Record<string, unknown>;
    const user = extractUser(record);
    if (!user) {
      continue;
    }

    const selection = extractSelection(record);
    viewers.push({
      ...user,
      hasSelection: Boolean(selection),
      selection
    });
  }

  return viewers;
}

function renderRemotePresence(
  viewers: RemoteViewer[],
  presence: HTMLElement,
  anonymousViewerCount: number
): void {
  presence.innerHTML = "";
  if (anonymousViewerCount > 0) {
    const chip = document.createElement("span");
    chip.className = "presence-chip anonymous-viewers";
    chip.setAttribute("aria-label", anonymousViewerLabel(anonymousViewerCount));
    chip.title = anonymousViewerLabel(anonymousViewerCount);
    chip.innerHTML = `
      <span class="presence-eye" aria-hidden="true"></span>
      <span class="presence-count">${anonymousViewerCount}</span>
    `;
    presence.append(chip);
  }

  for (const viewer of viewers) {
    const chip = document.createElement("span");
    chip.className = `presence-chip ${viewer.hasSelection ? "has-selection" : ""}`;
    chip.style.borderColor = viewer.color;
    chip.textContent = viewer.label;
    presence.append(chip);
  }
}

function anonymousViewerLabel(count: number): string {
  const suffix = count % 10 === 1 && count % 100 !== 11
    ? "анонимный читатель"
    : "анонимных читателей";
  return `${count} ${suffix}`;
}

function renderRemoteCursors(article: HTMLElement, viewers: RemoteViewer[], sourceText: string): void {
  article.querySelector(".remote-cursor-layer")?.remove();
  const selectedViewers = viewers.filter((viewer) => viewer.selection);
  if (selectedViewers.length === 0) {
    return;
  }

  const layer = document.createElement("div");
  layer.className = "remote-cursor-layer";
  article.append(layer);

  for (const viewer of selectedViewers) {
    const selection = viewer.selection!;
    const rangeStart = Math.max(0, Math.min(selection.anchor, selection.head));
    const rangeEnd = Math.max(0, Math.max(selection.anchor, selection.head));

    if (rangeEnd > rangeStart) {
      for (const rect of selectionRectsAtSourceRange(article, sourceText, rangeStart, rangeEnd)) {
        const highlight = document.createElement("span");
        highlight.className = "remote-selection";
        highlight.style.left = `${rect.left}px`;
        highlight.style.top = `${rect.top}px`;
        highlight.style.width = `${rect.width}px`;
        highlight.style.height = `${rect.height}px`;
        highlight.style.background = viewer.color;
        layer.append(highlight);
      }
    }

    const position = Math.max(0, selection.head);
    const rect = caretRectAtSourceOffset(article, sourceText, position);
    if (!rect) {
      continue;
    }

    const caret = document.createElement("span");
    caret.className = "remote-caret";
    caret.style.left = `${rect.left}px`;
    caret.style.top = `${rect.top}px`;
    caret.style.height = `${rect.height}px`;
    caret.style.background = viewer.color;

    const label = document.createElement("span");
    label.className = "remote-caret-label";
    label.style.background = viewer.color;
    label.textContent = viewer.label;
    caret.append(label);
    layer.append(caret);
  }
}

function selectionRectsAtSourceRange(
  article: HTMLElement,
  sourceText: string,
  sourceStart: number,
  sourceEnd: number
): DOMRect[] {
  if (sourceEnd <= sourceStart) {
    return [];
  }

  return findSourceBlocksIntersecting(article, sourceStart, sourceEnd).flatMap((block) => {
    const blockStart = Number(block.dataset.sourceStart ?? "0");
    const blockEnd = Math.max(blockStart, Number(block.dataset.sourceEnd ?? blockStart));
    const rangeStart = Math.max(sourceStart, blockStart);
    const rangeEnd = Math.min(sourceEnd, blockEnd);
    if (rangeEnd <= rangeStart) {
      return [];
    }

    if (block.dataset.sourceKind === "math") {
      const rect = selectionRectInMathBlock(article, block, blockStart, blockEnd, rangeStart, rangeEnd);
      return rect ? [rect] : [];
    }

    const visibleStart = projectSourceToVisibleText(sourceText.slice(blockStart, rangeStart)).length;
    const visibleEnd = projectSourceToVisibleText(sourceText.slice(blockStart, rangeEnd)).length;
    return textRangeRectsAtTextOffsets(block, visibleStart, visibleEnd, article);
  });
}

function findSourceBlocksIntersecting(
  article: HTMLElement,
  sourceStart: number,
  sourceEnd: number
): HTMLElement[] {
  const candidates = [...article.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")].filter(
    (candidate) => {
      const start = Number(candidate.dataset.sourceStart);
      const end = Number(candidate.dataset.sourceEnd);
      return Number.isFinite(start) && Number.isFinite(end) && start < sourceEnd && sourceStart < end;
    }
  );

  return candidates
    .filter((candidate) => {
      return !candidates.some((other) => {
        if (candidate === other || !candidate.contains(other)) {
          return false;
        }

        const otherStart = Number(other.dataset.sourceStart);
        const otherEnd = Number(other.dataset.sourceEnd);
        return otherStart < sourceEnd && sourceStart < otherEnd;
      });
    })
    .sort((left, right) => Number(left.dataset.sourceStart) - Number(right.dataset.sourceStart));
}

function selectionRectInMathBlock(
  article: HTMLElement,
  block: HTMLElement,
  blockStart: number,
  blockEnd: number,
  selectionStart: number,
  selectionEnd: number
): DOMRect | null {
  const blockRect = block.getBoundingClientRect();
  if (blockRect.width === 0 && blockRect.height === 0) {
    return null;
  }

  const articleRect = article.getBoundingClientRect();
  const span = Math.max(1, blockEnd - blockStart);
  const startRatio = Math.max(0.04, Math.min(0.96, (selectionStart - blockStart) / span));
  const endRatio = Math.max(startRatio, Math.min(0.96, (selectionEnd - blockStart) / span));
  const left = blockRect.left - articleRect.left + blockRect.width * startRatio;
  const right = blockRect.left - articleRect.left + blockRect.width * endRatio;
  const height = Math.max(18, Math.min(blockRect.height, blockRect.height - 16));

  return new DOMRect(
    left,
    blockRect.top - articleRect.top + Math.max(4, (blockRect.height - height) / 2),
    Math.max(4, right - left),
    height
  );
}

function caretRectAtSourceOffset(
  article: HTMLElement,
  sourceText: string,
  sourceOffset: number
): DOMRect | null {
  // Awareness selections are offsets in the Markdown source, while the preview DOM hides syntax.
  // Keep cursor placement scoped to the rendered block that owns the original source range.
  const block = findSourceBlock(article, sourceOffset);
  if (!block) {
    return null;
  }

  const sourceStart = Number(block.dataset.sourceStart ?? "0");
  const sourceEnd = Math.max(sourceStart, Number(block.dataset.sourceEnd ?? sourceStart));
  const clampedOffset = Math.max(sourceStart, Math.min(sourceOffset, sourceEnd));

  if (block.dataset.sourceKind === "math") {
    return caretRectInBlockBySourceRatio(article, block, sourceStart, sourceEnd, clampedOffset);
  }

  const sourcePrefix = sourceText.slice(sourceStart, clampedOffset);
  const visibleOffset = projectSourceToVisibleText(sourcePrefix).length;
  return caretRectAtTextOffset(block, visibleOffset, article);
}

function findSourceBlock(article: HTMLElement, sourceOffset: number): HTMLElement | null {
  const candidates = [...article.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]")];
  const matches = candidates.filter((candidate) => {
    const start = Number(candidate.dataset.sourceStart);
    const end = Number(candidate.dataset.sourceEnd);
    return Number.isFinite(start) && Number.isFinite(end) && start <= sourceOffset && sourceOffset <= end;
  });

  return matches.sort((left, right) => {
    const leftSpan = Number(left.dataset.sourceEnd) - Number(left.dataset.sourceStart);
    const rightSpan = Number(right.dataset.sourceEnd) - Number(right.dataset.sourceStart);
    if (leftSpan !== rightSpan) {
      return leftSpan - rightSpan;
    }
    return left.contains(right) ? 1 : -1;
  })[0] ?? null;
}

function caretRectInBlockBySourceRatio(
  article: HTMLElement,
  block: HTMLElement,
  sourceStart: number,
  sourceEnd: number,
  sourceOffset: number
): DOMRect | null {
  const blockRect = block.getBoundingClientRect();
  if (blockRect.width === 0 && blockRect.height === 0) {
    return null;
  }

  const articleRect = article.getBoundingClientRect();
  const ratio =
    sourceEnd > sourceStart ? (sourceOffset - sourceStart) / (sourceEnd - sourceStart) : 0;
  const clampedRatio = Math.max(0.04, Math.min(0.96, ratio));
  const height = Math.max(18, Math.min(blockRect.height, blockRect.height - 16));
  return new DOMRect(
    blockRect.left - articleRect.left + blockRect.width * clampedRatio,
    blockRect.top - articleRect.top + Math.max(4, (blockRect.height - height) / 2),
    2,
    height
  );
}

function textRangeRectsAtTextOffsets(
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
  coordinateRoot = root
): DOMRect[] {
  if (endOffset <= startOffset) {
    return [];
  }

  const start = textPositionAtOffset(root, startOffset);
  const end = textPositionAtOffset(root, endOffset);
  if (!start || !end) {
    return [];
  }

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const coordinateRect = coordinateRoot.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map(
      (rect) =>
        new DOMRect(
          rect.left - coordinateRect.left,
          rect.top - coordinateRect.top,
          rect.width,
          Math.max(4, rect.height)
        )
    );
  range.detach();
  return rects;
}

function caretRectAtTextOffset(
  root: HTMLElement,
  targetOffset: number,
  coordinateRoot = root
): DOMRect | null {
  const position = textPositionAtOffset(root, targetOffset);
  if (position) {
    return textNodeCaretRect(position.node, position.offset, coordinateRoot);
  }

  const rootRect = root.getBoundingClientRect();
  const coordinateRect = coordinateRoot.getBoundingClientRect();
  return new DOMRect(
    rootRect.left - coordinateRect.left,
    rootRect.top - coordinateRect.top,
    2,
    Math.max(18, rootRect.height)
  );
}

function textPositionAtOffset(root: HTMLElement, targetOffset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(".remote-cursor-layer,[aria-hidden='true']")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    }
  });
  let offset = 0;
  let lastTextNode: Text | null = null;
  let current = walker.nextNode();

  while (current) {
    const textNode = current as Text;
    lastTextNode = textNode;
    const text = current.textContent ?? "";
    const nextOffset = offset + text.length;
    if (targetOffset <= nextOffset) {
      return {
        node: textNode,
        offset: Math.max(0, Math.min(text.length, targetOffset - offset))
      };
    }

    offset = nextOffset;
    current = walker.nextNode();
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.textContent?.length ?? 0
    };
  }

  return null;
}

function textNodeCaretRect(node: Text, offset: number, coordinateRoot: HTMLElement): DOMRect | null {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  range.detach();
  if (!rect || rect.width === 0 && rect.height === 0) {
    return null;
  }

  const rootRect = coordinateRoot.getBoundingClientRect();
  return new DOMRect(
    rect.left - rootRect.left,
    rect.top - rootRect.top,
    Math.max(2, rect.width),
    Math.max(18, rect.height)
  );
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
  target: string,
  currentEntryPath = ""
): PublicAsset | undefined {
  const clean = normalizeEmbedTarget(target);
  const sameFolder = siblingPath(currentEntryPath, clean);
  return (
    assets[clean] ??
    assets[`/${clean}`] ??
    (sameFolder ? assets[sameFolder] : undefined) ??
    assets[filename(clean)]
  );
}

function resolveEntry(
  entries: PublicEntry[],
  target: string,
  currentEntryPath = ""
): PublicEntry | undefined {
  const clean = normalizeEmbedTarget(target);
  const cleanLower = clean.toLowerCase();
  const cleanWithoutExtension = stripKnownExtension(cleanLower);
  const sameFolder = siblingPath(currentEntryPath, clean)?.toLowerCase();

  const scoreEntry = (entry: PublicEntry): number => {
    const path = normalizePath(entry.path).toLowerCase();
    const base = filename(path);
    if (sameFolder && stripKnownExtension(path) === stripKnownExtension(sameFolder)) {
      return 0;
    }
    if (path === cleanLower || `/${path}` === cleanLower) {
      return 1;
    }
    if (base === cleanLower) {
      return 2;
    }
    if (stripKnownExtension(path) === cleanWithoutExtension) {
      return 3;
    }
    if (stripKnownExtension(base) === cleanWithoutExtension) {
      return 4;
    }
    return Number.POSITIVE_INFINITY;
  };

  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.entry.path.localeCompare(right.entry.path))
    .at(0)?.entry;
}

function splitEmbedTarget(value: string): { target: string; alias?: string } {
  const [target, alias] = value.split("|", 2);
  return {
    target: target?.trim() ?? value.trim(),
    ...(alias?.trim() ? { alias: alias.trim() } : {})
  };
}

function normalizeEmbedTarget(target: string): string {
  return safeDecode(splitEmbedTarget(target).target)
    .replace(/^<|>$/g, "")
    .replace(/^\/+/, "")
    .split("#")[0]!
    .trim();
}

function stripKnownExtension(value: string): string {
  return value
    .replace(/\.excalidraw\.md$/i, "")
    .replace(/\.md$/i, "")
    .replace(/\.(png|jpe?g|gif|webp|svg)$/i, "");
}

function siblingPath(currentEntryPath: string, target: string): string | null {
  const cleanTarget = normalizePath(target);
  if (!currentEntryPath || cleanTarget.includes("/")) {
    return null;
  }

  const parent = normalizePath(currentEntryPath).split("/").slice(0, -1).join("/");
  return parent ? `${parent}/${cleanTarget}` : cleanTarget;
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

function stripFrontmatterWithOffset(raw: string): { content: string; sourceOffset: number } {
  const match = raw.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (!match) {
    return { content: raw, sourceOffset: 0 };
  }

  return {
    content: raw.slice(match[0].length),
    sourceOffset: match[0].length
  };
}

function normalizeLines(raw: string): string {
  return raw.replace(/\r\n?/g, "\n");
}

function createSourceMap(lines: string[], sourceOffset: number): SourceMap {
  let offset = sourceOffset;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  return {
    lineOffsets,
    lineLengths: lines.map((line) => line.length)
  };
}

function sourceEndForLine(source: SourceMap, endLine: number): number {
  const nextLineOffset = source.lineOffsets[endLine];
  if (nextLineOffset !== undefined) {
    return nextLineOffset;
  }

  const lastLine = Math.max(0, Math.min(endLine - 1, source.lineOffsets.length - 1));
  return (source.lineOffsets[lastLine] ?? 0) + (source.lineLengths[lastLine] ?? 0);
}

function projectSourceToVisibleText(source: string): string {
  return normalizeLines(source)
    .split("\n")
    .map((line) => projectSourceLineToVisibleText(line))
    .join("\n");
}

function projectSourceLineToVisibleText(line: string): string {
  let value = line;
  value = value.replace(/^>\s*\[!([A-Za-z0-9_-]+)](?:[+-])?\s*/, "");
  value = value.replace(/^>\s?/, "");
  value = value.replace(/^#{1,6}\s+/, "");
  value = value.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "");
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(value)) {
    return "";
  }

  value = value.replace(/^\s*\$\$+/, "");
  value = value.replace(/\$\$+\s*$/, "");
  value = value.replace(/^\s*\\\[/, "");
  value = value.replace(/\\\]\s*$/, "");

  return projectInlineSourceToVisibleText(value);
}

function projectInlineSourceToVisibleText(source: string): string {
  let value = source;

  value = value.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, target, label) =>
    String(label ?? target)
  );
  value = value.replace(/!\[([^\]]*)]\(([^)]+)\)/g, (_match, alt, target) =>
    String(alt || filename(String(target)))
  );
  value = value.replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1");
  value = value.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, target, label) =>
    String(label ?? target)
  );
  value = value.replace(/`([^`]*)`/g, "$1");
  value = value.replace(/\$\$([\s\S]*?)(?:\$\$)?/g, "$1");
  value = value.replace(/\\\[([\s\S]*?)(?:\\\])?/g, "$1");
  value = value.replace(/\\\(([\s\S]*?)(?:\\\))?/g, "$1");
  value = value.replace(/(^|[^\\])\$([^\n$]*)(?:\$)?/g, "$1$2");
  value = value.replace(/<font\b[^>]*>/gi, "");
  value = value.replace(/<\/font>/gi, "");
  value = value.replace(/<br\s*\/?>/gi, "\n");
  value = value.replace(/<\/?(sub|sup)>/gi, "");
  value = value.replace(/<\/?[^>]+>/g, "");
  value = value.replace(/\*\*|__|~~/g, "");
  value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  value = value.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");

  return value;
}

function calloutTitle(type: string): string {
  const normalized = calloutCanonicalType(type);
  const titles: Record<string, string> = {
    abstract: "Abstract",
    note: "Note",
    info: "Info",
    tip: "Tip",
    todo: "Todo",
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
  const normalized = calloutCanonicalType(type);
  const icons: Record<string, string> = {
    abstract: "≡",
    note: "i",
    info: "i",
    tip: "!",
    todo: "✓",
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

function calloutCanonicalType(type: string): string {
  const normalized = type.toLowerCase();
  const aliases: Record<string, string> = {
    summary: "abstract",
    tldr: "abstract",
    hint: "tip",
    check: "success",
    done: "success",
    fail: "failure",
    failed: "failure",
    missing: "failure",
    error: "danger",
    caution: "warning",
    attention: "warning",
    help: "question",
    faq: "question",
    cite: "quote"
  };
  return aliases[normalized] ?? normalized;
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

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
