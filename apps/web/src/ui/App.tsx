import { useEffect, useState } from "preact/hooks";
import type * as Y from "yjs";
import { createNote, deleteNote, listNotes, openIndex, type NoteMeta } from "../notes";
import { engine, type SyncStatus } from "../sync/engine";
import type { Session } from "../sync/session";
import { addTag, countTags, deleteTag, renameTag, tagMap, withTags } from "../tags";
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

  useEffect(() => engine.onStatus(setStatus), []);

  useEffect(() => {
    let idx: Y.Map<Y.Map<unknown>>;
    const refresh = () => setNotes(listNotes(idx));
    void openIndex().then((m) => {
      idx = m;
      setIndex(m);
      refresh();
      m.observeDeep(refresh);
      tagMap(m).observe(refresh);
    });
    return () => {
      idx?.unobserveDeep(refresh);
      if (idx) tagMap(idx).unobserve(refresh);
    };
  }, []);

  const tags = index ? countTags(index, notes) : [];
  // Drop filters whose tag was renamed or deleted (here or on another device).
  const filter = active.filter((t) => tags.some(([name]) => name === t));
  const shown = withTags(notes, filter);
  const toggle = (t: string) => setActive(filter.includes(t) ? filter.filter((x) => x !== t) : [...filter, t]);

  const add = () => {
    if (!index) return;
    const id = createNote(index);
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
                <button class="danger" onClick={() => remove(filter[0]!, shown.length)}>Delete</button>
              </>
            )}
            <button onClick={() => setActive([])} aria-label="Clear tag filter">×</button>
          </div>
        )}
        <ul>
          {shown.map((n) => (
            <li key={n.id}>
              <button class={n.id === selected ? "active" : ""} onClick={() => setSelected(n.id)}>
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
