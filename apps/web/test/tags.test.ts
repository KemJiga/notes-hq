import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { addTag, countTags, deleteTag, namesOf, normalizeTag, removeTag, renameTag, tagMap, withTags } from "../src/tags";

type Notes = Y.Map<Y.Map<unknown>>;
const notesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>("notes");

function addNote(notes: Notes, id: string) {
  const m = new Y.Map<unknown>();
  m.set("tags", new Y.Map<true>());
  notes.set(id, m);
}
const names = (notes: Notes, id: string) => namesOf(notes.get(id)!, tagMap(notes));
const list = (notes: Notes) => [...notes.keys()].map((id) => ({ id, tags: names(notes, id) }));

/** Two devices that start in sync, then edit offline until sync() exchanges their updates. */
function twoDevices(...noteIds: string[]) {
  const a = new Y.Doc();
  noteIds.forEach((id) => addNote(notesOf(a), id));
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

test("normalizeTag lowercases, strips #, joins words with -", () => {
  assert.equal(normalizeTag("  #Reading List "), "reading-list");
  assert.equal(normalizeTag("# "), "");
});

test("add reuses a same-name tag case-insensitively; remove takes it off", () => {
  const notes = notesOf(new Y.Doc());
  addNote(notes, "n1");
  addNote(notes, "n2");
  assert.equal(addTag(notes, "n1", "Ideas"), "ideas");
  addTag(notes, "n2", "IDEAS");
  assert.equal(tagMap(notes).size, 1);
  assert.deepEqual(names(notes, "n2"), ["ideas"]);
  removeTag(notes, "n2", "ideas");
  assert.deepEqual(names(notes, "n2"), []);
  assert.equal(addTag(notes, "n1", "  "), null);
});

test("add creates the per-note map for notes made before tags", () => {
  const notes = notesOf(new Y.Doc());
  notes.set("old", new Y.Map());
  addTag(notes, "old", "x");
  assert.deepEqual(names(notes, "old"), ["x"]);
});

test("rename updates every note; renaming onto an existing name merges", () => {
  const notes = notesOf(new Y.Doc());
  ["n1", "n2", "n3"].forEach((id) => addNote(notes, id));
  addTag(notes, "n1", "a");
  addTag(notes, "n2", "a");
  addTag(notes, "n3", "b");
  assert.equal(renameTag(notes, "a", "C"), "c");
  assert.deepEqual(list(notes).map((n) => n.tags), [["c"], ["c"], ["b"]]);
  renameTag(notes, "c", "b");
  assert.deepEqual(countTags(notes, list(notes)), [["b", 3]]);
});

test("delete removes the tag from all notes and leaves the notes", () => {
  const notes = notesOf(new Y.Doc());
  ["n1", "n2"].forEach((id) => addNote(notes, id));
  addTag(notes, "n1", "a");
  addTag(notes, "n1", "keep");
  addTag(notes, "n2", "a");
  deleteTag(notes, "a");
  assert.equal(notes.size, 2);
  assert.deepEqual(list(notes).map((n) => n.tags), [["keep"], []]);
  assert.deepEqual(countTags(notes, list(notes)), [["keep", 1]]);
});

test("countTags and withTags (AND)", () => {
  const notes = notesOf(new Y.Doc());
  ["n1", "n2", "n3"].forEach((id) => addNote(notes, id));
  addTag(notes, "n1", "a");
  addTag(notes, "n1", "b");
  addTag(notes, "n2", "a");
  addTag(notes, "n3", "unused");
  removeTag(notes, "n3", "unused");
  const l = list(notes);
  assert.deepEqual(countTags(notes, l), [["a", 2], ["b", 1], ["unused", 0]]);
  assert.deepEqual(withTags(l, ["a"]).map((n) => n.id), ["n1", "n2"]);
  assert.deepEqual(withTags(l, ["a", "b"]).map((n) => n.id), ["n1"]);
  assert.equal(withTags(l, []).length, 3);
});

test("offline: one device adds A, the other adds B to the same note -> both", () => {
  const { a, b, sync } = twoDevices("n");
  addTag(a, "n", "alpha");
  addTag(b, "n", "beta");
  sync();
  assert.deepEqual(names(a, "n"), ["alpha", "beta"]);
  assert.deepEqual(names(b, "n"), ["alpha", "beta"]);
});

test("offline: concurrent remove and add of different tags both apply", () => {
  const { a, b, sync } = twoDevices("n");
  addTag(a, "n", "old");
  sync();
  removeTag(a, "n", "old");
  addTag(b, "n", "new");
  sync();
  assert.deepEqual(names(a, "n"), ["new"]);
  assert.deepEqual(names(b, "n"), ["new"]);
});

test("offline: same-name tags created on two devices act as one", () => {
  const { a, b, sync } = twoDevices("n1", "n2");
  addTag(a, "n1", "Ideas");
  addTag(b, "n2", "ideas");
  sync();
  assert.equal(tagMap(a).size, 2); // two ids...
  for (const notes of [a, b]) {
    const l = list(notes);
    assert.deepEqual(countTags(notes, l), [["ideas", 2]]); // ...one tag
    assert.deepEqual(withTags(l, ["ideas"]).map((n) => n.id), ["n1", "n2"]);
  }
  // Later adds reuse one of them, and rename/delete/remove reach both.
  addTag(a, "n1", "ideas");
  assert.equal(tagMap(a).size, 2);
  renameTag(a, "ideas", "thoughts");
  assert.deepEqual(countTags(a, list(a)), [["thoughts", 2]]);
  removeTag(a, "n2", "thoughts");
  assert.deepEqual(names(a, "n2"), []);
  deleteTag(a, "thoughts");
  assert.equal(tagMap(a).size, 0);
});

test("offline: a tag deleted on one device while added to a note on the other stays gone", () => {
  const { a, b, sync } = twoDevices("n1", "n2");
  addTag(a, "n1", "t");
  sync();
  deleteTag(a, "t");
  addTag(b, "n2", "t");
  sync();
  for (const notes of [a, b]) assert.deepEqual(countTags(notes, list(notes)), []);
});
