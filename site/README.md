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

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to
`main` that changes `site/` (or by hand, with "Run workflow"). There is no build
step: the files are uploaded as they are.

## Keeping it in step

The run diagram is a copy of `docs/assets/run-*.svg`. When you change one,
copy it to the matching file here. The two `demo-*.svg` recordings are generated
by `scripts/build-demo-svgs.mjs`, which writes both `docs/assets/` and `site/assets/`. Command lines on the page must
exist in `graphloom --help`, and the quickstart must match
[`docs/design-release.md`](../docs/design-release.md).
