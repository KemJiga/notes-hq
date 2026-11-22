import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type * as Y from "yjs";
import { createFolder, deleteFolder, isWithin, moveFolder, nameTaken, pathTo, renameFolder, type Tree } from "../folders";
import { dragSource, dropTarget, MoveSheet } from "./move";

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
export function NameInput(props: { tree: Tree; parentId: string | null; initial?: string; except?: string; label: string; onSave: (name: string) => void; onCancel: () => void }) {
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
          if (e.key === "Escape") {
            e.preventDefault(); // inside the Move sheet, Esc cancels the name, not the sheet
            onCancel();
          }
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
  const isFolder = (v: View) => v !== ALL && v !== UNFILED;
  const item = (view: View, icon: string, name: string, count: number) => (
    <button
      key={view}
      class="nav-item"
      aria-current={view === top ? "page" : undefined}
      onClick={() => onOpen(view)}
      {...(isFolder(view) ? { ...dragSource("folder", () => [view]), ...dropTarget(index, tree, view, true) } : view === UNFILED ? dropTarget(index, tree, null) : {})}
    >
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
            const id = createFolder(index, name); // null if the name was taken meanwhile: the field stays, now flagged
            if (id) {
              setCreating(false);
              onOpen(id);
            }
          }}
        />
      )}
      {!collapsed && tree.roots.map((id) => item(id, "📁", tree.folders.get(id)!.name, counts.get(id) ?? 0))}
    </nav>
  );
}

type HeaderProps = { index: Index; tree: Tree; counts: Map<string | null, number>; here: View; shown: number; onOpen: (v: View) => void; children?: ComponentChildren };

/** Note list header: breadcrumb to the open folder, note count, and the folder's actions. */
export function ListHeader({ index, tree, counts, here, shown, onOpen, children }: HeaderProps) {
  const [mode, setMode] = useState<"rename" | "create" | "move" | null>(null);
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
                <button class="crumb" onClick={() => onOpen(f.id)} {...dropTarget(index, tree, f.id)}>{f.name}</button>
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
                onSave={(name) => renameFolder(index, f.id, name) && setMode(null)}
              />
            ) : (
              <strong key={f.id} aria-current="page">{f.name}</strong>
            ),
          )}
        </nav>
        <span class="count">{plural(shown, "note")}</span>
      </div>
      <div class="actions">
        {folder && (
          <>
            <button onClick={() => setMode("create")}>New folder</button>
            <button onClick={() => setMode("rename")}>Rename</button>
            <button aria-haspopup="dialog" onClick={() => setMode("move")}>Move</button>
            <button class="danger" onClick={remove}>Delete</button>
          </>
        )}
        {children}
      </div>
      {folder && mode === "move" && (
        <MoveSheet
          index={index}
          tree={tree}
          title={`Move “${folder.name}”`}
          rootLabel="Top level"
          current={folder.parentId}
          disabled={(id) => id !== null && isWithin(tree, id, folder.id)}
          onPick={(id) => id !== folder.parentId && moveFolder(index, folder.id, id)} // re-picking its place keeps its order
          onClose={() => setMode(null)}
        />
      )}
      {folder && mode === "create" && (
        <NameInput
          tree={tree}
          parentId={folder.id}
          label={`New folder in ${folder.name}`}
          onCancel={() => setMode(null)}
          onSave={(name) => createFolder(index, name, folder.id) && setMode(null)}
        />
      )}
    </div>
  );
}

/** The open folder's subfolders, as list items above its notes. */
export function SubfolderRows({ index, tree, counts, here, onOpen }: Omit<HeaderProps, "shown">) {
  const children = tree.folders.get(here)?.children ?? [];
  return (
    <>
      {children.map((id) => {
        const f = tree.folders.get(id)!;
        return (
          <li key={id}>
            <button class="folder-row" onClick={() => onOpen(id)} {...dragSource("folder", () => [id])} {...dropTarget(index, tree, id)}>
              <span aria-hidden="true">📁</span> {f.name}
              <small>{plural(counts.get(id) ?? 0, "note")}{f.children.length ? ` · ${plural(f.children.length, "folder")}` : ""}</small>
            </button>
          </li>
        );
      })}
    </>
  );
}
