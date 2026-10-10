/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Default relay URL suggested to users, e.g. wss://relay.example.com. Optional. */
  readonly VITE_RELAY_URL?: string;
}
