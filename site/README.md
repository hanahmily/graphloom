# GraphLoom website

A static page: plain HTML and CSS, no JavaScript, no external requests (no CDN,
web fonts or trackers). Light and dark follow `prefers-color-scheme`. The
run diagram in `assets/` is the same SVG the repository keeps in `docs/assets/`,
plus the mark and the hero weave.

## Preview

Open `site/index.html` in a browser, or serve the directory:

```sh
python3 -m http.server 8000 --directory site
```

then visit <http://localhost:8000>.

## Publishing

GitHub Pages can serve `site/` once the repository is public. Nothing here
configures Pages or an Actions workflow; do that when the repository is public.

## Keeping it in step

The run diagram is a copy of `docs/assets/run-*.svg`. When you change one,
copy it to the matching file here. Command lines on the page must
exist in `graphloom --help`, and the quickstart must match
[`docs/design-release.md`](../docs/design-release.md).
