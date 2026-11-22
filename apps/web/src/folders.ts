/**
 * Folders live in the index doc next to tags, so the tree syncs eagerly.
 *   index.getMap("folders")          folderId -> Y.Map { name, parentId: string | null, order: number }
 *   notes.get(id).get("folderId")    string | null; none (or a folder that no longer exists) = Unfiled
 * Each folder is its own Y.Map, so a rename on one device and a move on another both survive.
 * Offline devices can merge into states no single device would write: a folder whose parent was
 * deleted, or a cycle (A moved into B here, B into A there). buildTree() repairs both when it reads,
 * the same way on every device, and never writes, so devices can't fight over the repair.
 * Names are checked for clashes only where the user types one (create, rename). Merges, moves and
 * deletes can still put two same-name folders side by side; both show.
 */
import * as Y from "yjs";

type Notes = Y.Map<Y.Map<unknown>>;

export interface Folder {
  id: string;
  name: string;
  parentId: string | null; // after repair: always an existing folder, never part of a cycle
  order: number;
  children: string[]; // sorted
}
export interface Tree {
  folders: Map<string, Folder>;
  roots: string[]; // sorted
}

export const folderMap = (notes: Notes) => notes.doc!.getMap<Y.Map<unknown>>("folders");

/** The note's folder, or null for Unfiled (also when its folder was deleted, here or elsewhere). */
export function folderOf(notes: Notes, meta: Y.Map<unknown>): string | null {
  const id = meta.get("folderId") as string | null | undefined;
  return id != null && folderMap(notes).has(id) ? id : null;
}

export function buildTree(notes: Notes): Tree {
  const folders = new Map<string, Folder>();
  folderMap(notes).forEach((m, id) =>
    folders.set(id, {
      id,
      name: String(m.get("name") ?? ""),
      parentId: (m.get("parentId") as string | null | undefined) ?? null,
      order: Number(m.get("order") ?? 0),
      children: [],
    }),
  );
  // Orphans: the parent was deleted, so the folder goes to the top level.
  for (const f of folders.values()) if (f.parentId !== null && !folders.has(f.parentId)) f.parentId = null;
  // Cycles: every folder has one parent, so a cycle is a loop of parent links and loops never share
  // a folder. Breaking each loop at its smallest id depends only on the state, not on visit order.
  const done = new Set<string>();
  for (const start of folders.keys()) {
    const path: string[] = [];
    let id: string | null = start;
    while (id !== null && !done.has(id) && !path.includes(id)) {
      path.push(id);
      id = folders.get(id)!.parentId;
    }
    if (id !== null && path.includes(id)) folders.get(path.slice(path.indexOf(id)).sort()[0]!)!.parentId = null;
    path.forEach((p) => done.add(p));
  }
  const roots: string[] = [];
  for (const f of folders.values()) (f.parentId === null ? roots : folders.get(f.parentId)!.children).push(f.id);
  const byOrder = (a: string, b: string) => folders.get(a)!.order - folders.get(b)!.order || (a < b ? -1 : a > b ? 1 : 0);
  roots.sort(byOrder);
  for (const f of folders.values()) f.children.sort(byOrder);
  return { folders, roots };
}

const siblings = (tree: Tree, parentId: string | null) => (parentId === null ? tree.roots : tree.folders.get(parentId)?.children ?? []);

/** True if `id` is `ancestor` or lies anywhere inside it. */
export function isWithin(tree: Tree, id: string | null, ancestor: string): boolean {
  for (let cur = id; cur !== null; cur = tree.folders.get(cur)?.parentId ?? null) if (cur === ancestor) return true;
  return false;
}

/** The folder and its ancestors, top level first. */
export function pathTo(tree: Tree, id: string): Folder[] {
  const path: Folder[] = [];
  for (let f = tree.folders.get(id); f; f = f.parentId === null ? undefined : tree.folders.get(f.parentId)) path.unshift(f);
  return path;
}

/** Another folder next to it already uses this name (case-insensitive). */
export function nameTaken(tree: Tree, parentId: string | null, name: string, except?: string): boolean {
  const n = name.trim().toLowerCase();
  return siblings(tree, parentId).some((id) => id !== except && tree.folders.get(id)!.name.toLowerCase() === n);
}

const nextOrder = (tree: Tree, parentId: string | null) => {
  const s = siblings(tree, parentId);
  return s.length ? tree.folders.get(s[s.length - 1]!)!.order + 1 : 0;
};

/** Creates a folder at the end of its parent (null = top level). Returns its id, or null if the name is empty or taken. */
export function createFolder(notes: Notes, name: string, parentId: string | null = null): string | null {
  const tree = buildTree(notes);
  const n = name.trim();
  if (!n || nameTaken(tree, parentId, n) || (parentId !== null && !tree.folders.has(parentId))) return null;
  const id = crypto.randomUUID();
  const m = new Y.Map<unknown>();
  m.set("name", n);
  m.set("parentId", parentId);
  m.set("order", nextOrder(tree, parentId));
  folderMap(notes).set(id, m);
  return id;
}

/** Returns false if the name is empty or another folder next to it has it. */
export function renameFolder(notes: Notes, id: string, name: string): boolean {
  const tree = buildTree(notes);
  const f = tree.folders.get(id);
  const n = name.trim();
  if (!f || !n || nameTaken(tree, f.parentId, n, id)) return false;
  folderMap(notes).get(id)!.set("name", n);
  return true;
}

/**
 * Moves a folder into `parentId` (null = top level), placed before sibling `before`, or last.
 * Returns false when that would put the folder inside itself.
 */
export function moveFolder(notes: Notes, id: string, parentId: string | null, before: string | null = null): boolean {
  const tree = buildTree(notes);
  if (!tree.folders.has(id) || (parentId !== null && (!tree.folders.has(parentId) || isWithin(tree, parentId, id)))) return false;
  if (before === id) return true; // dropped onto itself
  const s = siblings(tree, parentId).filter((x) => x !== id);
  const i = before === null ? -1 : s.indexOf(before);
  const o = (x: string) => tree.folders.get(x)!.order;
  const order = i < 0 ? (s.length ? o(s[s.length - 1]!) + 1 : 0) : i === 0 ? o(s[0]!) - 1 : (o(s[i - 1]!) + o(s[i]!)) / 2;
  const map = folderMap(notes);
  notes.doc!.transact(() => {
    map.get(id)!.set("parentId", parentId);
    // No room between the neighbours (equal orders from concurrent creates, or floats worn thin): renumber them all.
    if (i > 0 && (order === o(s[i - 1]!) || order === o(s[i]!))) {
      s.splice(i, 0, id);
      s.forEach((x, n) => map.get(x)!.set("order", n));
    } else map.get(id)!.set("order", order);
  });
  return true;
}

/** Moves a note into a folder, or to Unfiled with null. */
export function moveNote(notes: Notes, noteId: string, folderId: string | null): void {
  const meta = notes.get(noteId);
  if (meta && (folderId === null || folderMap(notes).has(folderId))) meta.set("folderId", folderId);
}

/** Deletes the folder. Its notes and subfolders move to its parent (top-level folder: Unfiled / top level). */
export function deleteFolder(notes: Notes, id: string): void {
  const tree = buildTree(notes);
  const f = tree.folders.get(id);
  if (!f) return;
  const map = folderMap(notes);
  let next = nextOrder(tree, f.parentId);
  notes.doc!.transact(() => {
    // Subfolders go after the parent's own, in the order they had.
    for (const c of f.children) {
      map.get(c)!.set("parentId", f.parentId);
      map.get(c)!.set("order", next++);
    }
    // If f is in a loop buildTree breaks, the break is at the top of f's path, which still stores its
    // link into the loop. Store the break, or the children just moved into the loop would close a new one.
    const top = pathTo(tree, id)[0]!;
    if (top.id !== id && map.get(top.id)!.get("parentId") != null) map.get(top.id)!.set("parentId", null);
    notes.forEach((m) => m.get("folderId") === id && m.set("folderId", f.parentId));
    map.delete(id);
  });
}
