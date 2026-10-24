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

// iOS Safari lays the keyboard over the page instead of resizing it (Android does, via
// interactive-widget in index.html). Fit the app to the visible area so the bottom toolbar
// stays above the keyboard. Multiplying by scale ignores pinch-zoom.
const vv = window.visualViewport;
if (vv) {
  const fit = () => document.documentElement.style.setProperty("--app-height", `${vv.height * vv.scale}px`);
  vv.addEventListener("resize", fit);
  fit();
}

void boot();
