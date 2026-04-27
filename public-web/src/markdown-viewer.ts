import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType
} from "@codemirror/view";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField
} from "@codemirror/state";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { tags } from "@lezer/highlight";
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

interface RemoteCursor {
  from: number;
  to: number;
  color: string;
  label: string;
}

interface MathRange {
  from: number;
  to: number;
  expression: string;
  displayMode: boolean;
}

export interface MarkdownViewer {
  updateAssets(assets: Record<string, PublicAsset>): void;
  destroy(): void;
}

const setRemoteCursors = StateEffect.define<RemoteCursor[]>();
const setImageAssets = StateEffect.define<Record<string, PublicAsset>>();

class CursorWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly label: string
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const cursor = document.createElement("span");
    cursor.className = "remote-cursor";
    cursor.style.borderColor = this.color;
    cursor.dataset.label = this.label;
    return cursor;
  }
}

class ImageWidget extends WidgetType {
  constructor(private readonly asset: PublicAsset) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return this.asset.contentUrl === other.asset.contentUrl;
  }

  toDOM(): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "note-image";
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.src = this.asset.contentUrl;
    image.alt = this.asset.path;
    const caption = document.createElement("figcaption");
    caption.textContent = this.asset.path;
    figure.append(image, caption);
    return figure;
  }
}

class MathWidget extends WidgetType {
  constructor(
    private readonly expression: string,
    private readonly displayMode: boolean
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return this.expression === other.expression && this.displayMode === other.displayMode;
  }

  toDOM(): HTMLElement {
    const container = document.createElement(this.displayMode ? "div" : "span");
    container.className = this.displayMode ? "math-block" : "math-inline";
    try {
      katex.render(this.expression, container, {
        displayMode: this.displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false
      });
    } catch {
      container.textContent = this.expression;
    }
    return container;
  }
}

const remoteCursorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, transaction) {
    const effect = transaction.effects.find((candidate) => candidate.is(setRemoteCursors));
    if (!effect) {
      return transaction.docChanged ? value.map(transaction.changes) : value;
    }

    const builder = new RangeSetBuilder<Decoration>();
    for (const cursor of effect.value) {
      const from = clamp(cursor.from, 0, transaction.state.doc.length);
      const to = clamp(cursor.to, 0, transaction.state.doc.length);
      if (from !== to) {
        builder.add(
          Math.min(from, to),
          Math.max(from, to),
          Decoration.mark({
            class: "remote-selection",
            attributes: {
              style: `background-color: ${withAlpha(cursor.color, 0.22)}`
            }
          })
        );
      }
      builder.add(
        to,
        to,
        Decoration.widget({
          widget: new CursorWidget(cursor.color, cursor.label),
          side: 1
        })
      );
    }

    return builder.finish();
  },
  provide: (field) => EditorView.decorations.from(field)
});

const imageField = StateField.define<{
  assets: Record<string, PublicAsset>;
  decorations: DecorationSet;
}>({
  create(state) {
    return {
      assets: {},
      decorations: buildImageDecorations(state, {})
    };
  },
  update(value, transaction) {
    let assets = value.assets;
    let assetsChanged = false;
    for (const effect of transaction.effects) {
      if (effect.is(setImageAssets)) {
        assets = effect.value;
        assetsChanged = true;
      }
    }

    if (assetsChanged || transaction.docChanged) {
      return {
        assets,
        decorations: buildImageDecorations(transaction.state, assets)
      };
    }

    return {
      assets,
      decorations: value.decorations.map(transaction.changes)
    };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

const mathField = StateField.define<DecorationSet>({
  create(state) {
    return buildMathDecorations(state);
  },
  update(value, transaction) {
    if (!transaction.docChanged) {
      return value.map(transaction.changes);
    }

    return buildMathDecorations(transaction.state);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const rolayTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "#ebe4d6",
    fontSize: "16px"
  },
  ".cm-content": {
    fontFamily: '"Aptos", "Segoe UI", "Helvetica Neue", sans-serif',
    lineHeight: "1.74",
    padding: "28px",
    maxWidth: "960px"
  },
  ".cm-line": {
    padding: "0 2px"
  },
  ".cm-line:has(.cm-header)": {
    fontFamily: 'Georgia, "Times New Roman", serif'
  },
  ".cm-scroller": {
    overflow: "auto"
  }
});

const obsidianReadableHighlight = HighlightStyle.define([
  {
    tag: tags.heading1,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.72em",
    fontWeight: "700",
    lineHeight: "1.32",
    color: "#f1eadc"
  },
  {
    tag: tags.heading2,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.44em",
    fontWeight: "700",
    lineHeight: "1.36",
    color: "#f1eadc"
  },
  {
    tag: tags.heading3,
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontSize: "1.22em",
    fontWeight: "700",
    color: "#f1eadc"
  },
  {
    tag: [tags.heading4, tags.heading5, tags.heading6],
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: "700",
    color: "#f1eadc"
  },
  {
    tag: tags.strong,
    fontWeight: "700",
    color: "#fff2dd"
  },
  {
    tag: tags.emphasis,
    fontStyle: "italic",
    color: "#f4dfc7"
  },
  {
    tag: tags.strikethrough,
    textDecoration: "line-through",
    color: "#b7aea0"
  },
  {
    tag: tags.link,
    color: "#9fb9d9",
    textDecoration: "underline",
    textDecorationColor: "rgba(159, 185, 217, 0.38)"
  },
  {
    tag: tags.url,
    color: "#9fb9d9"
  },
  {
    tag: tags.monospace,
    borderRadius: "3px",
    backgroundColor: "rgba(255, 255, 255, 0.07)",
    color: "#ffd9a8",
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace'
  },
  {
    tag: tags.quote,
    color: "#cbbfae",
    fontStyle: "italic"
  },
  {
    tag: tags.list,
    color: "#d8a657"
  }
]);

export async function openMarkdownViewer(params: {
  entry: PublicEntry;
  manifest: PublicManifest;
  editorHost: HTMLElement;
  presence: HTMLElement;
}): Promise<MarkdownViewer> {
  params.editorHost.innerHTML = "";
  params.presence.innerHTML = "";

  const document = new Y.Doc();
  const text = document.getText("content");
  let assets = params.manifest.assets;
  const editor = new EditorView({
    parent: params.editorHost,
    state: EditorState.create({
      doc: "",
      extensions: [
        markdown(),
        syntaxHighlighting(obsidianReadableHighlight),
        rolayTheme,
        remoteCursorField,
        imageField,
        mathField,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping
      ]
    })
  });
  editor.dispatch({
    effects: setImageAssets.of(assets)
  });

  const token = await fetchJson<PublicCrdtToken>(
    `/public/api/rooms/${encodeURIComponent(params.manifest.workspace.id)}` +
      `/markdown/${encodeURIComponent(params.entry.id)}/crdt-token`,
    {
      method: "POST"
    }
  );
  let provider: HocuspocusProvider;
  provider = new HocuspocusProvider({
    url: token.wsUrl,
    name: token.docId,
    document,
    token: token.token,
    onSynced: ({ state }) => {
      if (state) {
        syncEditor(editor, text.toString(), assets);
        renderRemotePresence(provider, editor, params.presence);
      }
    }
  });
  // Public viewers are read-only observers: they must receive collaborator awareness,
  // but never publish a local "anonymous visitor" state that the server could reject.
  provider.awareness?.setLocalState(null);

  text.observe(() => {
    syncEditor(editor, text.toString(), assets);
  });
  const renderPresence = () => {
    renderRemotePresence(provider, editor, params.presence);
  };
  provider.awareness?.on("change", renderPresence);
  provider.awareness?.on("update", renderPresence);
  queueMicrotask(renderPresence);

  return {
    updateAssets(nextAssets) {
      assets = nextAssets;
      editor.dispatch({
        effects: setImageAssets.of(nextAssets)
      });
    },
    destroy() {
      provider.destroy();
      document.destroy();
      editor.destroy();
    }
  };
}

function syncEditor(
  editor: EditorView,
  nextText: string,
  assets: Record<string, PublicAsset>
): void {
  const current = editor.state.doc.toString();
  if (current !== nextText) {
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: nextText
      }
    });
  }
  editor.dispatch({
    effects: setImageAssets.of(assets)
  });
}

function renderRemotePresence(
  provider: HocuspocusProvider,
  editor: EditorView,
  presence: HTMLElement
): void {
  const awareness = provider.awareness;
  if (!awareness) {
    editor.dispatch({
      effects: setRemoteCursors.of([])
    });
    presence.innerHTML = "";
    return;
  }

  const cursors: RemoteCursor[] = [];
  const labels = new Map<string, { label: string; color: string }>();
  for (const value of awareness.getStates().values()) {
    const record = value as Record<string, unknown>;
    const user = extractUser(record);
    if (!user) {
      continue;
    }

    labels.set(`${user.label}:${user.color}:${labels.size}`, user);
    const selection = extractSelection(record);
    if (!selection) {
      continue;
    }

    cursors.push({
      from: selection.anchor,
      to: selection.head,
      color: user.color,
      label: user.label
    });
  }

  editor.dispatch({
    effects: setRemoteCursors.of(cursors)
  });
  presence.innerHTML = "";
  for (const viewer of labels.values()) {
    const chip = document.createElement("span");
    chip.className = "presence-chip";
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

function buildImageDecorations(
  state: EditorState,
  assets: Record<string, PublicAsset>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const content = state.doc.toString();
  const pattern = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    const rawTarget = (match[1] ?? match[2] ?? "").trim();
    const asset = resolveAsset(assets, rawTarget);
    if (!asset || match.index === undefined) {
      continue;
    }

    builder.add(
      match.index,
      match.index + match[0].length,
      Decoration.replace({
        widget: new ImageWidget(asset)
      })
    );
  }

  return builder.finish();
}

function buildMathDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of findMathRanges(state.doc.toString())) {
    builder.add(
      range.from,
      range.to,
      Decoration.replace({
        widget: new MathWidget(range.expression, range.displayMode),
        block: range.displayMode
      })
    );
  }

  return builder.finish();
}

function findMathRanges(content: string): MathRange[] {
  const ranges: MathRange[] = [];
  addMathMatches(content, ranges, /\$\$([\s\S]+?)\$\$/g, true);
  addMathMatches(content, ranges, /\\\[([\s\S]+?)\\\]/g, true);
  addMathMatches(content, ranges, /\\\(([\s\S]+?)\\\)/g, false);

  const inlineDollar = /(^|[^\\])\$([^\n$]+?)\$/g;
  for (const match of content.matchAll(inlineDollar)) {
    if (match.index === undefined || !match[2]) {
      continue;
    }

    const expression = match[2].trim();
    if (!expression || expression.length !== match[2].length) {
      continue;
    }

    const from = match.index + match[1]!.length;
    const to = from + match[0].length - match[1]!.length;
    addMathRange(ranges, {
      from,
      to,
      expression,
      displayMode: false
    });
  }

  return ranges.sort((left, right) => left.from - right.from || left.to - right.to);
}

function addMathMatches(
  content: string,
  ranges: MathRange[],
  pattern: RegExp,
  displayMode: boolean
): void {
  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) {
      continue;
    }

    const expression = match[1].trim();
    if (!expression) {
      continue;
    }

    addMathRange(ranges, {
      from: match.index,
      to: match.index + match[0].length,
      expression,
      displayMode
    });
  }
}

function addMathRange(ranges: MathRange[], next: MathRange): void {
  if (ranges.some((range) => rangesOverlap(range, next))) {
    return;
  }

  ranges.push(next);
}

function rangesOverlap(left: MathRange, right: MathRange): boolean {
  return left.from < right.to && right.from < left.to;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return color;
}
