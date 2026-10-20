import type { CodeSymbol, GraphEdge, GraphNode } from "@adam/core";
import { formatBytes, h } from "./dom";
import type { Host } from "./host";

const KIND_LABEL: Record<CodeSymbol["kind"], string> = {
  function: "fn",
  method: "method",
  constructor: "ctor",
  accessor: "get/set",
  class: "class",
  interface: "interface",
  type: "type",
  enum: "enum",
  variable: "const",
};

interface PanelContext {
  host: Host;
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
  onSelect: (id: string) => void;
}

/**
 * The node panel: what a file is, what it connects to, and its symbols collapsed by default.
 * Expanding a symbol fetches just that symbol's code.
 */
export function renderNodePanel(container: HTMLElement, node: GraphNode, ctx: PanelContext): void {
  const { host } = ctx;
  container.replaceChildren();

  const openButton =
    host.openFile && !node.binary
      ? h(
          "button",
          { class: "primary", onclick: () => host.openFile!(node.id), title: "Open in the editor to edit by hand" },
          node.sensitive ? "Open in editor (shows values)" : "Open in editor",
        )
      : null;

  container.append(
    h(
      "header",
      { class: "panel-head" },
      h("div", { class: "panel-title" }, node.sensitive ? `🔒 ${node.name}` : node.name),
      h("div", { class: "panel-path" }, node.id),
      h(
        "div",
        { class: "chips" },
        h("span", { class: "chip" }, node.language),
        h("span", { class: "chip" }, formatBytes(node.size)),
        !node.binary && h("span", { class: "chip" }, `${node.lines} lines`),
        node.binary && h("span", { class: "chip" }, "binary"),
        node.sensitive && h("span", { class: "chip danger" }, "sensitive"),
        node.secretHints > 0 &&
          h("span", { class: "chip warn", title: "Secret-looking values in this file are masked" }, `${node.secretHints} secret${node.secretHints > 1 ? "s" : ""} masked`),
      ),
      openButton,
    ),
  );

  if (node.sensitive) {
    container.append(
      h(
        "p",
        { class: "notice danger" },
        `${node.sensitiveReason ?? "Protected file"}. Values are never shown in Adam or sent to a model.`,
      ),
    );
    if (node.envDeclares.length) container.append(section("Declares (values hidden)", tagList(node.envDeclares)));
  }

  if (node.symbols.length) {
    const list = h("div", { class: "symbols" });
    const topLevel = node.symbols.filter((s) => !s.parent);
    for (const sym of topLevel) {
      const members = node.symbols.filter((s) => s.parent === sym.id);
      list.append(symbolRow(node, sym, ctx, members));
    }
    container.append(section(`Symbols (${node.symbols.length})`, list));
  } else if (node.parsed) {
    container.append(section("Symbols", h("p", { class: "muted" }, "No functions, classes or types declared here.")));
  } else if (!node.binary && !node.sensitive) {
    container.append(
      section("Symbols", h("p", { class: "muted" }, `Symbols for ${node.language} files come in a later release. The file is still a node with its connections.`)),
    );
  }

  container.append(
    section(`Imports (${ctx.outgoing.length})`, edgeList(ctx.outgoing, "target", ctx)),
    section(`Imported by (${ctx.incoming.length})`, edgeList(ctx.incoming, "source", ctx)),
  );
  if (node.packages.length) container.append(section(`Packages (${node.packages.length})`, tagList(node.packages)));
  if (node.envReads.length) container.append(section(`Reads env (${node.envReads.length})`, tagList(node.envReads)));
  if (node.unresolved.length) {
    container.append(
      section(`Unresolved imports (${node.unresolved.length})`, tagList(node.unresolved, "warn"), "These look local but no file matched. A broken path, or an alias Adam could not read."),
    );
  }
}

function symbolRow(node: GraphNode, sym: CodeSymbol, ctx: PanelContext, members: CodeSymbol[]): HTMLElement {
  const code = h("pre", { class: "code" });
  const body = h("div", { class: "symbol-body" }, code);
  const details = h(
    "details",
    { class: "symbol" },
    h(
      "summary",
      {},
      h("span", { class: `kind kind-${sym.kind}` }, KIND_LABEL[sym.kind]),
      h("span", { class: "symbol-name" }, sym.name),
      sym.exported && !sym.parent ? h("span", { class: "exported", title: "Exported" }, "export") : null,
      h("span", { class: "line" }, `L${sym.start.line}`),
    ),
    h("div", { class: "signature" }, sym.signature),
    body,
  );

  let loaded = false;
  details.addEventListener("toggle", () => {
    if (!details.open || loaded) return;
    loaded = true;
    code.textContent = "Loading…";
    ctx.host
      .getSymbol(node.id, sym.id)
      .then((res) => {
        code.textContent = res.content;
        if (res.redactions) body.prepend(h("p", { class: "notice warn" }, "Secret-looking values in this code are masked."));
      })
      .catch((err: Error) => {
        loaded = false;
        code.textContent = `Could not load: ${err.message}`;
      });
  });

  if (ctx.host.openFile) {
    body.append(h("button", { class: "link", onclick: () => ctx.host.openFile!(node.id, sym.start.line) }, `Open at line ${sym.start.line}`));
  }
  if (members.length) {
    const nested = h("div", { class: "symbols nested" });
    for (const m of members) nested.append(symbolRow(node, m, ctx, []));
    body.append(nested);
  }
  return details;
}

function edgeList(edges: GraphEdge[], end: "source" | "target", ctx: PanelContext): HTMLElement {
  if (!edges.length) return h("p", { class: "muted" }, end === "source" ? "Nothing imports this node." : "No local imports.");
  const ul = h("ul", { class: "edges" });
  for (const e of [...edges].sort((a, b) => a[end].localeCompare(b[end]))) {
    const label = e.kind === "imports" ? (e.typeOnly ? "type" : "") : e.kind;
    ul.append(
      h(
        "li",
        {},
        h("button", { class: "link", onclick: () => ctx.onSelect(e[end]), title: `${e.kind} "${e.specifier}"` }, e[end]),
        label ? h("span", { class: "edge-kind" }, label) : null,
      ),
    );
  }
  return ul;
}

function tagList(items: string[], tone = ""): HTMLElement {
  return h("div", { class: "tags" }, ...items.map((i) => h("span", { class: `tag ${tone}` }, i)));
}

function section(title: string, content: HTMLElement, hint?: string): HTMLElement {
  return h("section", { class: "panel-section" }, h("h3", {}, title), hint ? h("p", { class: "muted small" }, hint) : null, content);
}
