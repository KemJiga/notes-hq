/**
 * Data model.
 *   "index"       one Y.Doc: Y.Map "notes" of id -> Y.Map { title, createdAt, updatedAt, deleted }
 *   "note:<id>"   one Y.Doc per note: Y.Text "body"
 * The index syncs eagerly; note bodies are opened (and synced) on demand,
 * so startup cost does not grow with the size of the archive.
 */
import * as Y from "yjs";
import { engine } from "./sync/engine";

export interface NoteMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export async function openIndex(): Promise<Y.Map<Y.Map<unknown>>> {
  const doc = await engine.open("index");
  return doc.getMap<Y.Map<unknown>>("notes");
}

export function listNotes(notes: Y.Map<Y.Map<unknown>>): NoteMeta[] {
  const out: NoteMeta[] = [];
  notes.forEach((m, id) => {
    if (m.get("deleted")) return;
    out.push({
      id,
      title: String(m.get("title") ?? ""),
      createdAt: Number(m.get("createdAt") ?? 0),
      updatedAt: Number(m.get("updatedAt") ?? 0),
    });
  });
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createNote(notes: Y.Map<Y.Map<unknown>>): string {
  const id = crypto.randomUUID();
  const meta = new Y.Map<unknown>();
  const now = Date.now();
  meta.set("title", "");
  meta.set("createdAt", now);
  meta.set("updatedAt", now);
  notes.set(id, meta);
  return id;
}

export function deleteNote(notes: Y.Map<Y.Map<unknown>>, id: string): void {
  const m = notes.get(id);
  if (m) {
    m.set("deleted", true);
    m.set("updatedAt", Date.now());
  }
}

export async function openNoteBody(id: string): Promise<Y.Text> {
  const doc = await engine.open(`note:${id}`);
  return doc.getText("body");
}

/** Keeps the index entry's title and timestamp in step with local edits of the body. */
export function touchNote(notes: Y.Map<Y.Map<unknown>>, id: string, body: string): void {
  const m = notes.get(id);
  if (!m) return;
  const title = body.trimStart().split("\n", 1)[0]!.slice(0, 120);
  m.doc!.transact(() => {
    if (m.get("title") !== title) m.set("title", title);
    m.set("updatedAt", Date.now());
  });
}
