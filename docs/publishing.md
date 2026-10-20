# Publishing the extension

Adam ships to two registries so it works in every VS Code flavour:

- **Visual Studio Marketplace**: VS Code itself.
- **Open VSX**: VSCodium, Cursor, Windsurf, Gitpod and other VS Code forks.

## Build a package locally

```sh
npm ci
npm run check     # typecheck, tests, bundles
npm run package   # writes packages/vscode/adam-<version>.vsix
```

Install the `.vsix` by hand to try it: **Extensions → ⋯ → Install from VSIX…**, or
`code --install-extension packages/vscode/adam-0.1.0.vsix`.

## One-time setup before the first publish

1. **Pick the publisher ID.** `packages/vscode/package.json` uses the placeholder `adam-ide`.
   Create a publisher at <https://marketplace.visualstudio.com/manage> and put its ID in the
   `publisher` field. The extension's public ID becomes `<publisher>.adam`.
2. **Marketplace token.** Create an Azure DevOps personal access token with the
   *Marketplace → Manage* scope, and save it as the repository secret `VSCE_PAT`.
3. **Open VSX token.** Sign in at <https://open-vsx.org> with GitHub, sign the publisher
   agreement, create the namespace (`npx ovsx create-namespace <publisher> -p <token>`), and save
   the token as the repository secret `OVSX_PAT`.
4. **Licence.** `LICENSE.md` is an all-rights-reserved placeholder. Replace it if Adam should be
   open source.

Tokens never go in the repository; they live only in GitHub's encrypted secrets.

## Publish

Bump `version` in `packages/vscode/package.json`, add a `CHANGELOG.md` entry, merge to `main`, then
run the **Publish extension** workflow from the Actions tab. It runs every check, packages once and
publishes the same `.vsix` to the registries you pick.
