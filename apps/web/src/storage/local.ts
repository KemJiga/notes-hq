/**
 * Local persistence: one IndexedDB record per doc holding its full Yjs state,
 * the last relay seq applied, and local edits not yet acknowledged by the relay.
 * Writing all three in one record keeps them consistent across crashes.
 */

export interface DocRecord {
  name: string;
  state: Uint8Array;
  seq: number;
  pending: Uint8Array | null;
}

const DB_NAME = "notes-hq";
const STORE = "docs";
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "name" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const localStore = {
  get: (name: string) => tx<DocRecord | undefined>("readonly", (s) => s.get(name)),
  put: (rec: DocRecord) => tx("readwrite", (s) => s.put(rec)).then(() => undefined),
  /** Forget relay positions after switching sync session; all local content will be re-sent. */
  async resetSync(): Promise<void> {
    const all = await tx<DocRecord[]>("readonly", (s) => s.getAll());
    // Everything this device has becomes "unsent" so it is pushed to the new room.
    for (const r of all) await localStore.put({ ...r, seq: 0, pending: r.state });
  },
};
