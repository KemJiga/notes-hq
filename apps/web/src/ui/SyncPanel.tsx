import { useState } from "preact/hooks";
import { engine, type SyncStatus } from "../sync/engine";
import { defaultRelayUrl, joinLink, newSession, saveSession, type Session } from "../sync/session";

interface Props {
  session: Session | null;
  status: SyncStatus;
  onChange: (s: Session | null) => void;
  onClose: () => void;
}

export function SyncPanel({ session, status, onChange, onClose }: Props) {
  const [relay, setRelay] = useState(defaultRelayUrl());
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const apply = async (next: Session | null) => {
    setError("");
    try {
      saveSession(next);
      await engine.setSession(next, { switched: true });
      onChange(next);
    } catch (e) {
      setError(String(e));
    }
  };

  const join = () => {
    try {
      const url = new URL(paste.trim());
      const params = new URLSearchParams(url.hash.replace(/^#join\?/, ""));
      const r = params.get("r");
      const k = params.get("k");
      if (!r || !k) throw new Error();
      void apply({ relay: r, secret: k });
    } catch {
      setError("That doesn't look like a notes-hq join link.");
    }
  };

  return (
    <div class="panel" role="dialog" aria-label="Sync">
      <header>
        <h2>Sync</h2>
        <button onClick={onClose} aria-label="Close">×</button>
      </header>

      {session ? (
        <>
          <p>
            Status: <strong>{status}</strong>
            <br />
            Relay: <code>{session.relay}</code>
          </p>
          <p>Open this link on another device to add it. Anyone with the link can read and edit your notes, so only share it with your own devices.</p>
          <textarea class="link" readOnly value={joinLink(session)} rows={3} />
          <div class="row">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(joinLink(session));
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button class="danger" onClick={() => apply(null)}>Stop syncing this device</button>
          </div>
        </>
      ) : (
        <>
          <p>Notes are stored only on this device. Start a sync session to share them with your other devices through a relay you host.</p>
          <label>
            Relay URL
            <input value={relay} onInput={(e) => setRelay(e.currentTarget.value)} placeholder="wss://relay.example.com" />
          </label>
          <button onClick={() => apply(newSession(relay.trim()))}>Start a new sync session</button>
          <hr />
          <label>
            Or paste a join link from another device
            <input value={paste} onInput={(e) => setPaste(e.currentTarget.value)} placeholder="https://…/#join?…" />
          </label>
          <button onClick={join}>Join</button>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
