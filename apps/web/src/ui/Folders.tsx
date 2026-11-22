import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type * as Y from "yjs";
import { createFolder, deleteFolder, nameTaken, pathTo, renameFolder, type Tree } from "../folders";

/** What the note list shows: every note, the notes without a folder, or one folder (by id; ids are UUIDs). */
export const ALL = "all";
export const UNFILED = "unfiled";
export type View = string;

type Index = Y.Map<Y.Map<unknown>>;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const COLLAPSED_KEY = "notes-hq:folders-collapsed";
function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
function saveCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    // remembering is a convenience; private windows may refuse storage
  }
}

/** Inline folder name field: Enter saves, Esc or leaving the field cancels. Flags names already used next to it. */
function NameInput(props: { tree: Tree; parentId: string | null; initial?: string; except?: string; label: string; onSave: (name: string) => void; onCancel: () => void }) {
  const { tree, parentId, initial = "", except, label, onSave, onCancel } = props;
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const taken = nameTaken(tree, parentId, value, except);
  const id = `name-help-${except ?? parentId ?? "top"}`;
  return (
    <div class="name-input">
      <input
        ref={ref}
        aria-label={label}
        aria-invalid={taken}
        aria-describedby={id}
        enterKeyHint="done"
        value={value}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return; // Enter is picking an IME candidate
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && value.trim() && !taken) onSave(value);
        }}
        onBlur={onCancel}
      />
      <small id={id} class={taken ? "error" : ""} aria-live="polite">
        {taken ? `You already have a folder named “${value.trim()}” here. Pick another name.` : `Enter to ${initial ? "save" : "create"} · Esc to cancel`}
      </small>
    </div>
  );
}

type NavProps = { index: Index; tree: Tree; counts: Map<string | null, number>; total: number; here: View; onOpen: (v: View) => void };

/** Sidebar: All notes, Unfiled, and the top-level folders. Deeper folders open from the note list. */
export function FolderNav({ index, tree, counts, total, here, onOpen }: NavProps) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [creating, setCreating] = useState(false);
  const top = tree.folders.has(here) ? pathTo(tree, here)[0]!.id : here;
  const collapse = (v: boolean) => {
    setCollapsed(v);
    saveCollapsed(v);
  };
  const item = (view: View, icon: string, name: string, count: number) => (
    <button key={view} class="nav-item" aria-current={view === top ? "page" : undefined} onClick={() => onOpen(view)}>
      <span aria-hidden="true">{icon}</span>
      <span class="name">{name}</span>
      <span class="count">{count}</span>
    </button>
  );
  return (
    <nav class="folders" aria-label="Folders">
      {item(ALL, "▤", "All notes", total)}
      {item(UNFILED, "📥", "Unfiled", counts.get(null) ?? 0)}
      <div class="nav-section">
        <button aria-expanded={!collapsed} onClick={() => collapse(!collapsed)}>
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span> Folders
        </button>
        <button
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            collapse(false);
            setCreating(true);
          }}
        >
          +
        </button>
      </div>
      {creating && (
        <NameInput
          tree={tree}
          parentId={null}
          label="New folder name"
          onCancel={() => setCreating(false)}
          onSave={(name) => {
            setCreating(false);
            const id = createFolder(index, name);
            if (id) onOpen(id);
          }}
        />
      )}
      {!collapsed && tree.roots.map((id) => item(id, "📁", tree.folders.get(id)!.name, counts.get(id) ?? 0))}
    </nav>
  );
}

type HeaderProps = { index: Index; tree: Tree; counts: Map<string | null, number>; here: View; shown: number; onOpen: (v: View) => void };

/** Note list header: breadcrumb to the open folder, note count, and the folder's actions. */
export function ListHeader({ index, tree, counts, here, shown, onOpen }: HeaderProps) {
  const [mode, setMode] = useState<"rename" | "create" | null>(null);
  const folder = tree.folders.get(here);
  const path = folder ? pathTo(tree, here) : [];
  useEffect(() => setMode(null), [here]);

  const remove = () => {
    if (!folder) return;
    const parent = folder.parentId === null ? null : tree.folders.get(folder.parentId)!;
    // counts include subfolders; the notes directly in this folder are what's left after theirs.
    const notes = folder.children.reduce((n, c) => n - (counts.get(c) ?? 0), counts.get(folder.id) ?? 0);
    const subs = folder.children.length;
    const go = (n: number, what: string) => `${plural(n, what)} ${n === 1 ? "moves" : "move"}`;
    const parts = parent
      ? [(notes || subs) && `Its ${[notes && plural(notes, "note"), subs && plural(subs, "subfolder")].filter(Boolean).join(" and ")} ${notes + subs === 1 ? "moves" : "move"} to “${parent.name}”`]
      : [notes && `Its ${go(notes, "note")} to Unfiled`, subs && `${notes ? "its" : "Its"} ${go(subs, "subfolder")} to the top level`];
    const said = parts.filter(Boolean).join(" and ");
    const msg = `Delete “${folder.name}”?\n\nThe folder is removed from all your devices.${said ? ` ${said}, so nothing is lost.` : ""}`;
    if (!confirm(msg)) return;
    deleteFolder(index, folder.id);
    onOpen(parent?.id ?? UNFILED);
  };

  return (
    <div class="list-header">
      <div class="crumbs-row">
        <nav class="crumbs" aria-label="Breadcrumb">
          {!folder && <strong>{here === UNFILED ? "Unfiled" : "All notes"}</strong>}
          {path.map((f, i) =>
            i < path.length - 1 ? (
              <span key={f.id}>
                <button class="crumb" onClick={() => onOpen(f.id)}>{f.name}</button>
                <span aria-hidden="true"> / </span>
              </span>
            ) : mode === "rename" ? (
              <NameInput
                key={f.id}
                tree={tree}
                parentId={f.parentId}
                initial={f.name}
                except={f.id}
                label="Folder name"
                onCancel={() => setMode(null)}
                onSave={(name) => {
                  setMode(null);
                  renameFolder(index, f.id, name);
                }}
              />
            ) : (
              <strong key={f.id} aria-current="page">{f.name}</strong>
            ),
          )}
        </nav>
        <span class="count">{plural(shown, "note")}</span>
      </div>
      {folder && (
        <div class="actions">
          <button onClick={() => setMode("create")}>New folder</button>
          <button onClick={() => setMode("rename")}>Rename</button>
          <button class="danger" onClick={remove}>Delete</button>
        </div>
      )}
      {folder && mode === "create" && (
        <NameInput
          tree={tree}
          parentId={folder.id}
          label={`New folder in ${folder.name}`}
          onCancel={() => setMode(null)}
          onSave={(name) => {
            setMode(null);
            createFolder(index, name, folder.id);
          }}
        />
      )}
    </div>
  );
}

/** The open folder's subfolders, as list items above its notes. */
export function SubfolderRows({ tree, counts, here, onOpen }: Omit<HeaderProps, "index" | "shown">) {
  const children = tree.folders.get(here)?.children ?? [];
  return (
    <>
      {children.map((id) => {
        const f = tree.folders.get(id)!;
        return (
          <li key={id}>
            <button class="folder-row" onClick={() => onOpen(id)}>
              <span aria-hidden="true">📁</span> {f.name}
              <small>{plural(counts.get(id) ?? 0, "note")}{f.children.length ? ` · ${plural(f.children.length, "folder")}` : ""}</small>
            </button>
          </li>
        );
      })}
    </>
  );
}
