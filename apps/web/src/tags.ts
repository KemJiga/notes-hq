/**
 * Tags live in the index doc, so they sync eagerly and filtering never opens note bodies.
 *   index.getMap("tags")          tagId -> { name, color }
 *   notes.get(id).get("tags")     Y.Map tagId -> true (set semantics: concurrent adds merge)
 * Names are unique case-insensitively by normalizing them. Ids that end up sharing a name
 * (created concurrently on two devices, or renamed into each other) act as one tag: every
 * helper below works by name, never by a single id.
 */
import * as Y from "yjs";

export interface Tag {
  name: string;
  color: string | null; // in the schema, no picker yet (see "Design · Tags")
}
type Notes = Y.Map<Y.Map<unknown>>;

export const tagMap = (notes: Notes) => notes.doc!.getMap<Tag>("tags");

/** "  #Reading List " -> "reading-list" */
export const normalizeTag = (raw: string) => raw.trim().replace(/^#+/, "").trim().toLowerCase().replace(/\s+/g, "-");

function idsNamed(notes: Notes, name: string): string[] {
  const ids: string[] = [];
  tagMap(notes).forEach((t, id) => t.name === name && ids.push(id));
  return ids.sort();
}

/** Sorted names of a note's tags; ids whose tag was deleted elsewhere are ignored. */
export function namesOf(meta: Y.Map<unknown>, tags: Y.Map<Tag>): string[] {
  const names = new Set<string>();
  for (const id of (meta.get("tags") as Y.Map<true> | undefined)?.keys() ?? []) {
    const t = tags.get(id);
    if (t) names.add(t.name);
  }
  return [...names].sort();
}

/** Adds a tag by name, creating it if no tag has that name. Returns the normalized name, or null. */
export function addTag(notes: Notes, noteId: string, raw: string): string | null {
  const name = normalizeTag(raw);
  const meta = notes.get(noteId);
  if (!name || !meta) return null;
  notes.doc!.transact(() => {
    let id = idsNamed(notes, name)[0];
    if (!id) tagMap(notes).set((id = crypto.randomUUID()), { name, color: null });
    let set = meta.get("tags") as Y.Map<true> | undefined;
    // shortcut: notes from before tags get their map here; if two offline devices both give such a
    // note its first tag, one side's tags are lost. createNote makes the map up front for new notes.
    if (!set) meta.set("tags", (set = new Y.Map<true>()));
    set.set(id, true);
  });
  return name;
}

export function removeTag(notes: Notes, noteId: string, name: string): void {
  const set = notes.get(noteId)?.get("tags") as Y.Map<true> | undefined;
  if (set) notes.doc!.transact(() => idsNamed(notes, name).forEach((id) => set.delete(id)));
}

/** Renames every tag called `from`. Renaming onto an existing name merges the two. Returns the new name, or null. */
export function renameTag(notes: Notes, from: string, to: string): string | null {
  const name = normalizeTag(to);
  if (!name) return null;
  const tags = tagMap(notes);
  notes.doc!.transact(() => idsNamed(notes, from).forEach((id) => tags.set(id, { ...tags.get(id)!, name })));
  return name;
}

/** Deletes the tag and takes it off every note. The notes themselves are not touched. */
export function deleteTag(notes: Notes, name: string): void {
  const tags = tagMap(notes);
  const ids = idsNamed(notes, name);
  notes.doc!.transact(() => {
    ids.forEach((id) => tags.delete(id));
    notes.forEach((meta) => {
      const set = meta.get("tags") as Y.Map<true> | undefined;
      ids.forEach((id) => set?.has(id) && set.delete(id));
    });
  });
}

/** [name, note count] for every tag, sorted by name. `list` holds the live (non-deleted) notes. */
export function countTags(notes: Notes, list: { tags: string[] }[]): [string, number][] {
  const counts = new Map<string, number>();
  tagMap(notes).forEach((t) => counts.set(t.name, 0));
  for (const n of list) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/** Notes carrying every one of the given tags (AND). */
export const withTags = <T extends { tags: string[] }>(list: T[], active: string[]) =>
  active.length ? list.filter((n) => active.every((t) => n.tags.includes(t))) : list;
