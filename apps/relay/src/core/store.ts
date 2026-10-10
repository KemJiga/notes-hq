/**
 * Storage for one relay. Both supported runtimes (`node:sqlite`, built into Bun and Node,
 * and SQLite-backed Cloudflare Durable Objects) expose a synchronous SQL API,
 * so the whole store is written once against a tiny `Sql` function.
 *
 * The relay stores only ciphertext. It never sees note contents or titles.
 */

export type Row = Record<string, unknown>;

/** Runs one SQL statement with positional `?` params and returns result rows. */
export type Sql = (query: string, ...params: (string | number)[]) => Row[];

export interface Entry {
  seq: number;
  data: string;
}

export interface Backlog {
  snapshot: Entry | null;
  entries: Entry[];
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS updates (
     room TEXT NOT NULL, doc TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (room, doc, seq)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     room TEXT NOT NULL, doc TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (room, doc)
   ) WITHOUT ROWID`,
];

export function migrate(sql: Sql): void {
  for (const stmt of SCHEMA) sql(stmt);
}

/** Store scoped to a single room. Callers must not run two calls concurrently (both runtimes are single-threaded). */
export class RoomStore {
  constructor(
    private readonly sql: Sql,
    readonly room: string,
  ) {}

  /** Latest seq for a doc, 0 if empty. */
  head(doc: string): number {
    const u = this.sql("SELECT MAX(seq) AS s FROM updates WHERE room = ? AND doc = ?", this.room, doc)[0];
    const s = this.sql("SELECT seq AS s FROM snapshots WHERE room = ? AND doc = ?", this.room, doc)[0];
    return Math.max(Number(u?.s ?? 0), Number(s?.s ?? 0));
  }

  append(doc: string, data: string): number {
    const seq = this.head(doc) + 1;
    this.sql("INSERT INTO updates (room, doc, seq, data) VALUES (?, ?, ?, ?)", this.room, doc, seq, data);
    return seq;
  }

  /** Everything a client that has applied up to `since` is missing. */
  read(doc: string, since: number): Backlog {
    const snapRow = this.sql("SELECT seq, data FROM snapshots WHERE room = ? AND doc = ?", this.room, doc)[0];
    const snapSeq = snapRow ? Number(snapRow.seq) : 0;
    const snapshot = snapRow && since < snapSeq ? { seq: snapSeq, data: String(snapRow.data) } : null;
    const from = snapshot ? snapshot.seq : since;
    const entries = this.sql(
      "SELECT seq, data FROM updates WHERE room = ? AND doc = ? AND seq > ? ORDER BY seq",
      this.room,
      doc,
      from,
    ).map((r) => ({ seq: Number(r.seq), data: String(r.data) }));
    return { snapshot, entries };
  }

  /** Replaces entries with seq <= upTo by a snapshot. Returns false if the request is stale or invalid. */
  compact(doc: string, upTo: number, data: string): boolean {
    const head = this.head(doc);
    const current = this.sql("SELECT seq FROM snapshots WHERE room = ? AND doc = ?", this.room, doc)[0];
    if (upTo < 1 || upTo > head || (current && Number(current.seq) >= upTo)) return false;
    this.sql("DELETE FROM updates WHERE room = ? AND doc = ? AND seq <= ?", this.room, doc, upTo);
    this.sql(
      "INSERT INTO snapshots (room, doc, seq, data) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (room, doc) DO UPDATE SET seq = excluded.seq, data = excluded.data",
      this.room,
      doc,
      upTo,
      data,
    );
    return true;
  }
}
