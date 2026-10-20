type Child = Node | string | null | undefined | false;

/** Tiny element builder. Text always goes in as text, never as HTML, so repo content cannot inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((e: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, "").toLowerCase(), value);
    else if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Section titles the user has closed, without their counts, so a section stays closed as the panel re-renders. */
const closed = new Set<string>();

/** A section that opens and closes from its heading. Each one remembers being closed, by title, until it is opened again. */
export function collapsible(title: string, props: Partial<Record<string, string>>, ...children: Child[]): HTMLDetailsElement {
  const key = title.replace(/\s*\(\d[\d,]*\)$/, "");
  const details = h("details", { ...props, open: !closed.has(key) }, h("summary", {}, h("h3", {}, title)), ...children);
  details.addEventListener("toggle", () => (details.open ? closed.delete(key) : closed.add(key)));
  return details;
}
