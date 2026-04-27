import { markdown } from "@codemirror/lang-markdown";
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

const rolayTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    color: "#f2ecd7",
    fontSize: "16px"
  },
  ".cm-content": {
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    lineHeight: "1.72",
    padding: "28px"
  },
  ".cm-line": {
    padding: "0 2px"
  },
  ".cm-scroller": {
    overflow: "auto"
  }
});

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
        rolayTheme,
        remoteCursorField,
        imageField,
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
  const provider = new HocuspocusProvider({
    url: token.wsUrl,
    name: token.docId,
    document,
    token: token.token,
    onSynced: ({ state }) => {
      if (state) {
        syncEditor(editor, text.toString(), assets);
      }
    }
  });

  text.observe(() => {
    syncEditor(editor, text.toString(), assets);
  });
  provider.awareness.on("change", () => {
    renderRemotePresence(provider, editor, params.presence);
  });

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
  const cursors: RemoteCursor[] = [];
  for (const value of provider.awareness.getStates().values()) {
    const record = value as {
      user?: { displayName?: string; color?: string };
      selection?: { anchor?: number; head?: number };
    };
    if (!record.user?.displayName || !record.selection) {
      continue;
    }

    const anchor = Number(record.selection.anchor);
    const head = Number(record.selection.head);
    if (!Number.isFinite(anchor) || !Number.isFinite(head)) {
      continue;
    }

    cursors.push({
      from: anchor,
      to: head,
      color: record.user.color ?? "#b9f18d",
      label: record.user.displayName
    });
  }

  editor.dispatch({
    effects: setRemoteCursors.of(cursors)
  });
  presence.innerHTML = "";
  for (const cursor of cursors) {
    const chip = document.createElement("span");
    chip.className = "presence-chip";
    chip.style.borderColor = cursor.color;
    chip.textContent = cursor.label;
    presence.append(chip);
  }
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
