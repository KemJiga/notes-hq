import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { buildTree, createFolder, deleteFolder, folderMap, folderOf, isWithin, moveFolder, moveNote, nameTaken, renameFolder, type Tree } from "../src/folders";

type Notes = Y.Map<Y.Map<unknown>>;
const notesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("notes");
const addNote = (notes: Notes, id: string) => notes.set(id, new Y.Map<unknown>());
const folderOfNote = (notes: Notes, id: string) => folderOf(notes, notes.get(id)!);

/** The tree as nested names, e.g. ["A", ["B"]] = A at the top level with B inside it. */
function shape(tree: Tree, ids = tree.roots): unknown[] {
  return ids.flatMap((id) => {
    const f = tree.folders.get(id)!;
    return f.children.length ? [f.name, shape(tree, f.children)] : [f.name];
  });
}
/** Every folder is reachable from the top level, so none is hidden. */
function reachable(tree: Tree): number {
  const walk = (ids: string[]): number => ids.reduce((n, id) => n + 1 + walk(tree.folders.get(id)!.children), 0);
  return walk(tree.roots);
}
/** Sets a folder's parent directly, like a raw merge would, bypassing moveFolder's checks. */
const setParent = (notes: Notes, id: string, parentId: string | null) => folderMap(notes).get(id)!.set("parentId", parentId);

/** Two devices that start in sync, then edit offline until sync() exchanges their updates. */
function twoDevices(setup: (notes: Notes) => void) {
  const a = new Y.Doc();
  setup(notesOf(a));
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, ua);
    Y.applyUpdate(a, ub);
  };
  return { a: notesOf(a), b: notesOf(b), sync };
}

test("create, nest at any depth, rename, reorder", () => {
  const notes = notesOf(new Y.Doc());
  const work = createFolder(notes, " Work ")!;
  const home = createFolder(notes, "Home")!;
  const deep = createFolder(notes, "c", createFolder(notes, "b", createFolder(notes, "a", work)!)!)!;
  assert.deepEqual(shape(buildTree(notes)), ["Work", ["a", ["b", ["c"]]], "Home"]);
  assert.ok(isWithin(buildTree(notes), deep, work));
  assert.equal(createFolder(notes, "  "), null);
  assert.equal(createFolder(notes, "work"), null, "names are unique next to each other, ignoring case");
  assert.ok(createFolder(notes, "work", home), "...but not across parents");
  assert.equal(createFolder(notes, "x", "missing"), null);
  assert.ok(renameFolder(notes, home, "House"));
  assert.ok(renameFolder(notes, home, "HOUSE"), "renaming to itself with new case is fine");
  assert.equal(renameFolder(notes, home, "WORK"), false);
  const misc = createFolder(notes, "Misc")!;
  moveFolder(notes, misc, null, work);
  assert.deepEqual(buildTree(notes).roots, [misc, work, home]);
  moveFolder(notes, misc, null, home);
  assert.deepEqual(buildTree(notes).roots, [work, misc, home]);
  moveFolder(notes, work, null);
  assert.deepEqual(buildTree(notes).roots, [misc, home, work]);
});

test("a folder can't move into itself or its own descendant", () => {
  const notes = notesOf(new Y.Doc());
  const a = createFolder(notes, "a")!;
  const b = createFolder(notes, "b", a)!;
  const c = createFolder(notes, "c", b)!;
  assert.equal(moveFolder(notes, a, a), false);
  assert.equal(moveFolder(notes, a, c), false);
  assert.ok(moveFolder(notes, c, null));
  assert.deepEqual(shape(buildTree(notes)), ["a", ["b"], "c"]);
});

test("moveFolder renumbers when the neighbours share an order; dropping a folder on itself is a no-op", () => {
  const notes = notesOf(new Y.Doc());
  const [x, y, z] = ["x", "y", "z"].map((n) => createFolder(notes, n)!);
  for (const id of [x, y]) folderMap(notes).get(id!)!.set("order", 0); // as after two offline creates
  const [first, second] = buildTree(notes).roots;
  moveFolder(notes, z!, null, second!);
  assert.deepEqual(buildTree(notes).roots, [first, z, second]);
  moveFolder(notes, first!, null, first!);
  assert.deepEqual(buildTree(notes).roots, [first, z, second]);
});

test("delete puts subfolders after the parent's own, in their order", () => {
  const notes = notesOf(new Y.Doc());
  const p = createFolder(notes, "p")!;
  ["a", "b"].forEach((n) => createFolder(notes, n, p));
  const gone = createFolder(notes, "gone", p)!;
  ["x", "y"].forEach((n) => createFolder(notes, n, gone));
  deleteFolder(notes, gone);
  assert.deepEqual(shape(buildTree(notes)), ["p", ["a", "b", "x", "y"]]);
});

test("delete moves notes and subfolders to the parent, or to Unfiled / top level", () => {
  const notes = notesOf(new Y.Doc());
  ["n1", "n2", "n3"].forEach((id) => addNote(notes, id));
  const top = createFolder(notes, "top")!;
  const mid = createFolder(notes, "mid", top)!;
  createFolder(notes, "leaf", mid);
  moveNote(notes, "n1", mid);
  moveNote(notes, "n2", top);
  deleteFolder(notes, mid);
  assert.deepEqual(shape(buildTree(notes)), ["top", ["leaf"]]);
  assert.equal(folderOfNote(notes, "n1"), top);
  deleteFolder(notes, top);
  assert.deepEqual(shape(buildTree(notes)), ["leaf"]);
  assert.deepEqual(["n1", "n2", "n3"].map((id) => folderOfNote(notes, id)), [null, null, null]);
  assert.equal(notes.size, 3, "notes are never deleted");
});

test("moveNote ignores folders that don't exist; orphaned notes show as Unfiled", () => {
  const notes = notesOf(new Y.Doc());
  addNote(notes, "n");
  moveNote(notes, "n", "missing");
  assert.equal(notes.get("n")!.get("folderId"), undefined);
  notes.get("n")!.set("folderId", "gone"); // e.g. written by an older or buggy client
  assert.equal(folderOfNote(notes, "n"), null);
});

test("offline: A into B on one device, B into A on the other -> same tree everywhere, none hidden", () => {
  let x = "", y = "";
  const { a, b, sync } = twoDevices((n) => {
    x = createFolder(n, "x")!;
    y = createFolder(n, "y")!;
  });
  moveFolder(a, x, y);
  moveFolder(b, y, x);
  sync();
  const [ta, tb] = [buildTree(a), buildTree(b)];
  assert.deepEqual(shape(ta), shape(tb));
  assert.equal(reachable(ta), 2);
  const [small, big] = [x, y].sort();
  assert.deepEqual(ta.roots, [small], "the loop breaks at the smallest id");
  assert.deepEqual(ta.folders.get(small!)!.children, [big]);
});

test("offline: a three-folder loop under a parent breaks at its smallest id, the parent stays", () => {
  let p = "", f: string[] = [];
  const { a, b, sync } = twoDevices((n) => {
    p = createFolder(n, "p")!;
    f = ["f1", "f2", "f3"].map((name) => createFolder(n, name)!);
  });
  moveFolder(a, f[0]!, f[1]!);
  moveFolder(a, f[1]!, f[2]!);
  moveFolder(b, f[2]!, f[0]!);
  moveFolder(b, p, f[2]!); // p hangs off the loop
  sync();
  const [ta, tb] = [buildTree(a), buildTree(b)];
  assert.deepEqual(shape(ta), shape(tb));
  assert.equal(reachable(ta), 4);
  assert.deepEqual(ta.roots, [[...f].sort()[0]]);
  assert.ok(isWithin(ta, p, f[2]!));
});

test("every parent layout of 5 folders repairs to the same full tree, whatever the insertion order", () => {
  const ids = ["f0", "f1", "f2", "f3", "f4"];
  const docs = [ids, [...ids].reverse()].map((order) => {
    const notes = notesOf(new Y.Doc());
    for (const id of order) folderMap(notes).set(id, new Y.Map<unknown>([["name", id]]));
    return notes;
  });
  const choices = [null, ...ids];
  for (let layout = 0; layout < choices.length ** ids.length; layout++) {
    const parents = ids.map((_, i) => choices[Math.floor(layout / choices.length ** i) % choices.length]!);
    for (const notes of docs) ids.forEach((id, i) => setParent(notes, id, parents[i]!));
    const [t0, t1] = docs.map((notes) => buildTree(notes));
    assert.equal(reachable(t0!), ids.length, `layout ${parents}`);
    assert.deepEqual(shape(t0!), shape(t1!), `layout ${parents}`);
  }
});

test("deleting a folder from a repaired cycle stores no new cycle", () => {
  for (const len of [2, 3]) {
    for (let del = 0; del < len; del++) {
      const notes = notesOf(new Y.Doc());
      const ids = Array.from({ length: len }, (_, i) => `c${i}`);
      ids.forEach((id) => folderMap(notes).set(id, new Y.Map<unknown>([["name", id]])));
      ids.forEach((id, i) => setParent(notes, id, ids[(i + 1) % len]!)); // c0 -> c1 -> ... -> c0
      const before = shape(buildTree(notes));
      deleteFolder(notes, ids[del]!);
      // The stored parent links (not the read-time repair) must already form a tree.
      const stored = new Map<string, string | null>();
      folderMap(notes).forEach((m, id) => stored.set(id, m.get("parentId") as string | null));
      for (const start of stored.keys()) {
        const seen = new Set<string>();
        for (let cur: string | null = start; cur !== null; cur = stored.get(cur) ?? null) {
          assert.ok(!seen.has(cur), `loop after deleting ${ids[del]} from ${before}`);
          seen.add(cur);
        }
      }
      assert.equal(reachable(buildTree(notes)), len - 1);
    }
  }
});

test("offline: folder deleted on one device while things move into it on the other", () => {
  let f = "", g = "", parent = "";
  const { a, b, sync } = twoDevices((n) => {
    addNote(n, "n");
    parent = createFolder(n, "parent")!;
    f = createFolder(n, "f", parent)!;
    g = createFolder(n, "g")!;
  });
  deleteFolder(a, f);
  moveNote(b, "n", f);
  moveFolder(b, g, f);
  sync();
  for (const notes of [a, b]) {
    const t = buildTree(notes);
    assert.equal(folderOfNote(notes, "n"), null, "the note falls back to Unfiled");
    assert.deepEqual(shape(t).sort(), ["g", "parent"], "the subfolder falls back to the top level");
  }
});

test("offline: rename on one device and move on the other both apply", () => {
  let f = "", p = "";
  const { a, b, sync } = twoDevices((n) => {
    f = createFolder(n, "f")!;
    p = createFolder(n, "p")!;
  });
  renameFolder(a, f, "renamed");
  moveFolder(b, f, p);
  sync();
  for (const notes of [a, b]) assert.deepEqual(shape(buildTree(notes)), ["p", ["renamed"]]);
});

test("offline: same-name folders created on two devices both show", () => {
  const { a, b, sync } = twoDevices(() => {});
  createFolder(a, "Work");
  createFolder(b, "Work");
  sync();
  assert.deepEqual(shape(buildTree(a)), ["Work", "Work"]);
  assert.deepEqual(shape(buildTree(a)), shape(buildTree(b)));
  assert.ok(nameTaken(buildTree(a), null, "work"));
});
