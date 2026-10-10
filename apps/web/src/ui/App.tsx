import { useCallback, useEffect, useState } from "preact/hooks";
import type * as Y from "yjs";
import { createNote, deleteNote, listNotes, openIndex, openNoteBody, touchNote, type NoteMeta } from "../notes";
import { engine, type SyncStatus } from "../sync/engine";
import type { Session } from "../sync/session";
import { SyncPanel } from "./SyncPanel";
import { useTextBinding } from "./useTextBinding";

export function App({ initialSession }: { initialSession: Session | null }) {
  const [index, setIndex] = useState<Y.Map<Y.Map<unknown>> | null>(null);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>(engine.status);
  const [session, setSession] = useState(initialSession);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => engine.onStatus(setStatus), []);

  useEffect(() => {
    let idx: Y.Map<Y.Map<unknown>>;
    const refresh = () => setNotes(listNotes(idx));
    void openIndex().then((m) => {
      idx = m;
      setIndex(m);
      refresh();
      m.observeDeep(refresh);
    });
    return () => idx?.unobserveDeep(refresh);
  }, []);

  const add = () => {
    if (!index) return;
    setSelected(createNote(index));
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
        <ul>
          {notes.map((n) => (
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
          <Editor
            key={selected}
            id={selected}
            index={index}
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

function Editor({ id, index, onDelete }: { id: string; index: Y.Map<Y.Map<unknown>>; onDelete: () => void }) {
  const [text, setText] = useState<Y.Text | null>(null);
  useEffect(() => {
    void openNoteBody(id).then(setText);
  }, [id]);
  const onLocal = useCallback((v: string) => touchNote(index, id, v), [index, id]);
  const ref = useTextBinding(text, onLocal);
  return (
    <div class="editor">
      <div class="toolbar">
        <button class="danger" onClick={onDelete}>Delete</button>
      </div>
      <textarea ref={ref} disabled={!text} placeholder="Start writing…" autoFocus />
    </div>
  );
}
