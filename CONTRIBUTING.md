# Contributing

Thanks for helping. A few principles keep this project what it is:

1. **No vendor lock-in.** Every feature must work on a self-hosted setup. Platform-specific code goes behind an adapter (see `apps/relay/src/cloudflare`), and the Node runtime stays the reference.
2. **The relay stays blind.** Never add anything that requires the relay to read note content. Features that need content, like search, previews, or imports, run on the client.
3. **Local first.** The UI must never wait on the network.
4. **Small.** Think twice before adding a dependency to `apps/web`, and check bundle size (`npm run build` prints it).

Before opening a PR:

```sh
npm run typecheck
npm test
npm run build
```

Protocol changes must update `docs/PROTOCOL.md` and `packages/protocol` together. Design changes should add or amend an entry in `docs/DESIGN.md` §4.
