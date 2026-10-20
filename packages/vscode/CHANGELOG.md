# Changelog

## 0.1.0 (preview)

- Network view: every file in the workspace is a node; TypeScript and JavaScript imports, re-exports, dynamic imports and `require` calls are edges, resolved through your `tsconfig.json` or `jsconfig.json` paths.
- Node panel: language, size, imports, imported-by, packages, env reads, unresolved imports, and every function, class, method and type, collapsed until you open it.
- Folder view over the same nodes, kept in sync with the selection.
- Sensitive nodes (`.env`, keys, credentials) are masked; secret-looking values in ordinary files are redacted.
- Indexing runs in a separate local service with an incremental cache in `.adam/`.
