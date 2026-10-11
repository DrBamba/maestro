# build/

Assets electron-builder reads at package time.

`icon.svg` is the master. Its gradient and filter ids (`g6a`, `soft6a`) are leftovers from the
design round it came out of. It is the thing to edit; do not touch the PNG by hand.

`icon.png` (1024×1024) is what macOS's `.icns` is built from. `icons/` holds the same artwork drawn
at each of the sizes Linux installs into `hicolor` — drawn, not downsampled, which is the point:
handed one large file electron-builder ships only that, and a 22px task-list entry made by shrinking
a 1024px render is a smudge. Regenerate both after changing the SVG:

```bash
linux/test.sh icon
```

That renders it in the Ubuntu container, because librsvg is the one dependency this repo needs that
a Mac does not come with — and the container already exists for the Linux build.
