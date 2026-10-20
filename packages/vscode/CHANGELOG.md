# Changelog

## Unreleased

- C# and .NET support: classes, structs, records, interfaces, enums, methods, constructors and properties are symbols; C# files link to the files whose types they use (namespaces, usings, global usings, aliases, static usings, limited to referenced projects), to extension methods they call, and between parts of a partial type. `.sln`/`.slnx` files link to their projects and `.csproj` files to their `<ProjectReference>`s; NuGet packages show on project nodes. Parsing runs as WebAssembly, so no .NET SDK or native build is needed.
- `appsettings*.json`, `local.settings.json`, user `secrets.json` and `web.config`/`app.config` are sensitive nodes that keep their keys (`ConnectionStrings:Default`) and mask every value. ADO.NET and Azure connection string passwords and keys in code are redacted.
- C# reads of `Environment.GetEnvironmentVariable`, `GetConnectionString` and `IConfiguration` keys show as env reads.

## 0.1.0 (preview)

- Network view: every file in the workspace is a node; TypeScript and JavaScript imports, re-exports, dynamic imports and `require` calls are edges, resolved through your `tsconfig.json` or `jsconfig.json` paths.
- Node panel: language, size, imports, imported-by, packages, env reads, unresolved imports, and every function, class, method and type, collapsed until you open it.
- Folder view over the same nodes, kept in sync with the selection.
- Sensitive nodes (`.env`, keys, credentials) are masked; secret-looking values in ordinary files are redacted.
- Indexing runs in a separate local service with an incremental cache in `.adam/`.
