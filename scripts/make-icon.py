"""Draws the extension icon (a small node network) at media/icon.png. Run: python3 scripts/make-icon.py"""
from PIL import Image, ImageDraw

S = 4  # supersample, then downscale for smooth edges
size = 256 * S
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, size - 1, size - 1], radius=56 * S, fill="#1a1a19")

nodes = {
    "a": ((128, 62), 22, "#3987e5"),
    "b": ((62, 132), 16, "#d95926"),
    "c": ((194, 128), 18, "#199e70"),
    "d": ((92, 200), 14, "#9085e9"),
    "e": ((170, 198), 15, "#c98500"),
    "f": ((128, 136), 12, "#e66767"),
}
edges = [("a", "b"), ("a", "c"), ("a", "f"), ("b", "d"), ("c", "e"), ("f", "d"), ("f", "e"), ("b", "f"), ("c", "f")]
for s, t in edges:
    (x1, y1), _, _ = nodes[s]
    (x2, y2), _, _ = nodes[t]
    d.line([x1 * S, y1 * S, x2 * S, y2 * S], fill="#6b6a64", width=5 * S)
for (x, y), r, color in nodes.values():
    d.ellipse([(x - r - 5) * S, (y - r - 5) * S, (x + r + 5) * S, (y + r + 5) * S], fill="#1a1a19")
    d.ellipse([(x - r) * S, (y - r) * S, (x + r) * S, (y + r) * S], fill=color)

img.resize((256, 256), Image.LANCZOS).save("packages/vscode/media/icon.png")
