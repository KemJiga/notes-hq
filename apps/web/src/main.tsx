import { render } from "preact";
import { engine } from "./sync/engine";
import { consumeJoinLink, loadSession, saveSession } from "./sync/session";
import { App } from "./ui/App";
import "./styles.css";

async function boot() {
  if (!window.isSecureContext || !crypto.subtle) {
    document.getElementById("app")!.textContent =
      "notes-hq needs a secure context (https:// or http://localhost) for encryption and offline support. See docs/SELF_HOSTING.md.";
    return;
  }
  const joined = consumeJoinLink();
  const current = loadSession();
  const session = joined ?? current;
  if (joined) saveSession(joined);
  await engine.setSession(session, { switched: !!joined && joined.secret !== current?.secret });
  render(<App initialSession={session} />, document.getElementById("app")!);
}

void boot();
