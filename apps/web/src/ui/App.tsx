import { useEffect, useState } from "preact/hooks";
import type * as Y from "yjs";
import { buildTree, moveNote, pathTo, type Tree } from "../folders";
import { createNote, deleteNote, listNotes, openIndex, type NoteMeta } from "../notes";
import { engine, type SyncStatus } from "../sync/engine";
import type { Session } from "../sync/session";
import { addTag, countTags, deleteTag, renameTag, withTags } from "../tags";
import { ALL, FolderNav, ListHeader, SubfolderRows, UNFILED, type View } from "./Folders";
import { dragSource, MoveSheet } from "./move";
import { NoteEditor } from "./NoteEditor";
import { SyncPanel } from "./SyncPanel";

export function App({ initialSession }: { initialSession: Session | null }) {
  const [index, setIndex] = useState<Y.Map<Y.Map<unknown>> | null>(null);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>(engine.status);
  const [session, setSession] = useState(initialSession);
  const [panelOpen, setPanelOpen] = useState(false);
  const [active, setActive] = useState<string[]>([]);
  const [tree, setTree] = useState<Tree>({ folders: new Map(), roots: [] });
  const [view, setView] = useState<View>(ALL);
  const [picked, setPicked] = useState<string[] | null>(null); // null = not selecting
  const [moving, setMoving] = useState(false);
  const open = (v: View) => {
    setView(v);
    setPicked(null);
  };

  useEffect(() => engine.onStatus(setStatus), []);

  useEffect(() => {
    let idx: Y.Map<Y.Map<unknown>> | undefined;
    let gone = false;
    const refresh = () => {
      setNotes(listNotes(idx!));
      setTree(buildTree(idx!));
    };
    void openIndex().then((m) => {
      if (gone) return;
      idx = m;
      setIndex(m);
      refresh();
      // Once per transaction, whether it touched notes, tags, folders or several of them.
      m.doc!.on("afterTransaction", refresh);
    });
    return () => {
      gone = true;
      idx?.doc!.off("afterTransaction", refresh);
    };
  }, []);

  const tags = index ? countTags(index, notes) : [];
  // Drop filters whose tag was renamed or deleted (here or on another device).
  const filter = active.filter((t) => tags.some(([name]) => name === t));
  // A folder deleted on another device drops the view back to All notes.
  const here = view === ALL || view === UNFILED || tree.folders.has(view) ? view : ALL;
  const folderId = here === ALL || here === UNFILED ? null : here;
  const inView = here === ALL ? notes : notes.filter((n) => n.folderId === folderId);
  const shown = withTags(inView, filter);
  // Only what's still listed counts: a filter change or a delete elsewhere can hide picked notes.
  const sel = picked?.filter((id) => shown.some((n) => n.id === id)) ?? [];
  // Notes per folder, subfolders included (null = Unfiled).
  const counts = new Map<string | null, number>();
  const inc = (k: string | null) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const n of notes) n.folderId === null ? inc(null) : pathTo(tree, n.folderId).forEach((f) => inc(f.id));
  const toggle = (t: string) => setActive(filter.includes(t) ? filter.filter((x) => x !== t) : [...filter, t]);

  const add = () => {
    if (!index) return;
    const id = createNote(index, folderId);
    filter.forEach((t) => addTag(index, id, t)); // so the new note shows in the filtered list
    setSelected(id);
  };

  const rename = (from: string) => {
    const to = prompt(`Rename tag “${from}”.\nRenaming a tag to one that already exists merges them.`, from);
    const name = to == null ? null : renameTag(index!, from, to);
    if (name) setActive([name]);
  };

  const remove = (name: string, count: number) => {
    const msg = `Delete tag “${name}”?\n\nIt’s removed from ${count} note${count === 1 ? "" : "s"} on all your devices. The notes themselves stay where they are.`;
    if (!confirm(msg)) return;
    deleteTag(index!, name);
    setActive([]);
  };

  return (
    <div class="app">
      <aside>
        <div class="toolbar">
          <button onClick={add} disabled={!index}>New note</button>
          <button class={`status ${status}`} onClick={() => setPanelOpen(true)} title="Sync settings">
            {status === "local-only" ? "Local only" : status}
          </button>
        </div>
        {index && <FolderNav index={index} tree={tree} counts={counts} total={notes.length} here={here} onOpen={open} />}
        {tags.length > 0 && (
          <nav class="tags" aria-label="Tags">
            {tags.map(([name, count]) => (
              <button key={name} class="chip" aria-pressed={filter.includes(name)} onClick={() => toggle(name)}>
                #{name} <span class="count">{count}</span>
              </button>
            ))}
          </nav>
        )}
        {filter.length > 0 && (
          <div class="filter">
            <strong>{filter.map((t) => `#${t}`).join(" + ")}</strong>
            <span class="count">{shown.length} note{shown.length === 1 ? "" : "s"}</span>
            {filter.length === 1 && (
              <>
                <button onClick={() => rename(filter[0]!)}>Rename</button>
                <button class="danger" onClick={() => remove(filter[0]!, tags.find(([t]) => t === filter[0])?.[1] ?? 0)}>Delete</button>
              </>
            )}
            <button onClick={() => setActive([])} aria-label="Clear tag filter">×</button>
          </div>
        )}
        {index && (
          <ListHeader index={index} tree={tree} counts={counts} here={here} shown={shown.length} onOpen={open}>
            {picked === null ? (
              <button onClick={() => setPicked([])}>Select</button>
            ) : (
              <>
                <span class="count">{sel.length} selected</span>
                <button aria-haspopup="dialog" disabled={!sel.length} onClick={() => setMoving(true)}>Move to…</button>
                <button onClick={() => setPicked(null)}>Done</button>
              </>
            )}
          </ListHeader>
        )}
        {index && moving && picked && (
          <MoveSheet
            index={index}
            tree={tree}
            title={`Move ${sel.length} note${sel.length === 1 ? "" : "s"}`}
            rootLabel="Unfiled"
            onPick={(id) => {
              index.doc!.transact(() => sel.forEach((n) => moveNote(index, n, id)));
              setPicked(null);
            }}
            onClose={() => setMoving(false)}
          />
        )}
        <ul>
          {index && <SubfolderRows index={index} tree={tree} counts={counts} here={here} onOpen={open} />}
          {shown.map((n) => (
            <li key={n.id}>
              <button
                class={n.id === selected ? "active" : ""}
                aria-pressed={picked ? picked.includes(n.id) : undefined}
                onClick={() => (picked ? setPicked(picked.includes(n.id) ? picked.filter((x) => x !== n.id) : [...picked, n.id]) : setSelected(n.id))}
                {...dragSource("note", () => (sel.includes(n.id) ? sel : [n.id]))}
              >
                {n.title || "Untitled"}
                <small>{new Date(n.updatedAt).toLocaleString()}</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main>
        {selected && index ? (
          <NoteEditor
            key={selected}
            id={selected}
            index={index}
            tags={tags}
            tree={tree}
            folderId={notes.find((n) => n.id === selected)?.folderId ?? null}
            onDelete={() => {
              deleteNote(index, selected);
              setSelected(null);
            }}
          />
        ) : (
          <p class="empty">Select or create a note.</p>
        )}
      </main>
      {panelOpen && (
        <SyncPanel session={session} status={status} onChange={setSession} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
