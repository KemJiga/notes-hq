/**
 * Moving notes and folders: drag & drop on desktop, and a "Move to…" sheet that works everywhere
 * (touch, keyboard). Both end in moveNote / moveFolder, so the moves sync like any other edit.
 */
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type * as Y from "yjs";
import { createFolder, isWithin, moveFolder, moveNote, type Tree } from "../folders";
import { NameInput } from "./Folders";

type Index = Y.Map<Y.Map<unknown>>;
type Dragged = { kind: "note" | "folder"; ids: string[] };
type Zone = "into" | "before" | "after";

// What is being dragged. Browsers hide dataTransfer contents until the drop, but targets need
// to know during dragover whether they accept it (e.g. a folder can't go into its own subfolder).
let dragged: Dragged | null = null;

/** Props that make an element draggable. `ids` is read when the drag starts (e.g. every selected note). */
export function dragSource(kind: Dragged["kind"], ids: () => string[]) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragged = { kind, ids: ids() };
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", ""); // Firefox won't start a drag without data
    },
    onDragEnd: () => (dragged = null),
  };
}

const ZONES = ["drop-into", "drop-before", "drop-after"];

/**
 * Props that make an element take drops into `folderId` (null = Unfiled, which takes notes only).
 * With `reorder`, a folder dropped on the top or bottom edge goes before or after this one instead of into it.
 */
export function dropTarget(index: Index, tree: Tree, folderId: string | null, reorder = false) {
  const zoneOf = (e: DragEvent): Zone | null => {
    if (!dragged) return null;
    if (dragged.kind === "note") return "into";
    if (folderId === null) return null;
    let zone: Zone = "into";
    if (reorder) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      zone = y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
    }
    const parent = zone === "into" ? folderId : tree.folders.get(folderId)?.parentId ?? null;
    if (dragged.ids.some((id) => id === folderId || (parent !== null && isWithin(tree, parent, id)))) return null;
    return zone;
  };
  const clear = (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove(...ZONES);
  return {
    onDragOver: (e: DragEvent) => {
      const zone = zoneOf(e);
      clear(e);
      if (!zone) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      (e.currentTarget as HTMLElement).classList.add(`drop-${zone}`);
    },
    onDragLeave: clear,
    onDrop: (e: DragEvent) => {
      const zone = zoneOf(e);
      clear(e);
      if (!zone || !dragged) return;
      e.preventDefault();
      const { kind, ids } = dragged;
      dragged = null;
      index.doc!.transact(() => {
        if (kind === "note") return ids.forEach((id) => moveNote(index, id, folderId));
        const f = tree.folders.get(folderId!)!;
        const sibs = f.parentId === null ? tree.roots : tree.folders.get(f.parentId)!.children;
        const after = sibs.slice(sibs.indexOf(f.id) + 1).find((s) => !ids.includes(s)) ?? null;
        for (const id of ids)
          if (zone === "into") moveFolder(index, id, f.id);
          else moveFolder(index, id, f.parentId, zone === "before" ? f.id : after);
      });
    },
  };
}

type SheetProps = {
  index: Index;
  tree: Tree;
  title: string;
  rootLabel: string; // what null means here: "Unfiled" for notes, "Top level" for folders
  current?: string | null;
  disabled?: (folderId: string | null) => boolean;
  onPick: (folderId: string | null) => void;
  onClose: () => void;
};

/** Modal list of every folder (indented by depth) to move something into. A bottom sheet on phones. */
export function MoveSheet({ index, tree, title, rootLabel, current, disabled, onPick, onClose }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [creating, setCreating] = useState(false);
  useLayoutEffect(() => ref.current?.showModal(), []);
  const pick = (id: string | null) => {
    onPick(id);
    ref.current?.close();
  };
  const rows: [string | null, number][] = [[null, 0]];
  const walk = (ids: string[], depth: number) =>
    ids.forEach((id) => {
      rows.push([id, depth]);
      walk(tree.folders.get(id)!.children, depth + 1);
    });
  walk(tree.roots, 0);
  return (
    <dialog
      ref={ref}
      class="sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        // Close on a click on the backdrop only: outside the dialog's box, not on its padding.
        const r = ref.current!.getBoundingClientRect();
        if (e.target === ref.current && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) ref.current!.close();
      }}
    >
      <div class="sheet-body">
        <header>
          <h2>{title}</h2>
          <button aria-label="Close" onClick={() => ref.current?.close()}>×</button>
        </header>
        <div class="sheet-list">
          {rows.map(([id, depth]) => (
            <button
              key={id ?? ""}
              class="nav-item"
              style={{ paddingLeft: `${8 + depth * 20}px` }}
              aria-current={id === current ? "true" : undefined}
              disabled={disabled?.(id)}
              onClick={() => pick(id)}
            >
              <span aria-hidden="true">{id === null ? "📥" : "📁"}</span>
              <span class="name">{id === null ? rootLabel : tree.folders.get(id)!.name}</span>
            </button>
          ))}
        </div>
        {creating ? (
          <NameInput
            tree={tree}
            parentId={null}
            label="New folder name"
            onCancel={() => setCreating(false)}
            onSave={(name) => {
              const id = createFolder(index, name); // null if the name was taken meanwhile: the field stays, now flagged
              if (id) pick(id);
            }}
          />
        ) : (
          <button class="secondary" onClick={() => setCreating(true)}>+ New folder</button>
        )}
      </div>
    </dialog>
  );
}

/** Editor chip showing the note's folder; opens the Move sheet. */
export function FolderChip({ index, tree, noteId, folderId }: { index: Index; tree: Tree; noteId: string; folderId: string | null }) {
  const [open, setOpen] = useState(false);
  const name = folderId === null ? "Unfiled" : tree.folders.get(folderId)?.name ?? "Unfiled";
  return (
    <>
      <button class="chip folder-chip" aria-haspopup="dialog" aria-label={`Folder: ${name}. Move to…`} onClick={() => setOpen(true)}>
        <span aria-hidden="true">📁</span> {name} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <MoveSheet
          index={index}
          tree={tree}
          title="Move to folder"
          rootLabel="Unfiled"
          current={folderId}
          onPick={(id) => moveNote(index, noteId, id)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
