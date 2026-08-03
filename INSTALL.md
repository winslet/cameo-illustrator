# Installing Cameo for Illustrator

**Requirements:** macOS 11 or newer, Adobe Illustrator 2020 (24.0) or newer, and
any Python 3.9 or newer.

Two steps: make sure you have Python, then install the extension.

---

## 1. Make sure you have Python 3

Open Terminal and run:

```bash
python3 --version
```

If that prints `Python 3.9` or higher, you're done — skip to step 2. If it
prints nothing, offers to install "command line developer tools", or errors,
install Python from [python.org/downloads](https://www.python.org/downloads/)
(the standard installer, signed by Apple).

You do **not** need Homebrew, `pip`, or any other package — everything else the
panel needs is inside the `.zxp`.

## 2. Install the extension

1. Download `cameo-illustrator-<version>.zxp` from the
   [latest release](https://github.com/winslet/cameo-illustrator/releases).
2. Install it with a ZXP installer — [ZXP Installer](https://zxpinstaller.com)
   is free and works fine. Drag the `.zxp` onto it.
3. It will warn you the extension comes from an **unknown publisher**. That's
   expected: the extension is signed, but with a self-signed certificate rather
   than one from a commercial authority. Continue.
4. Quit Illustrator **completely** and reopen it.
5. **Window → Extensions → Send to Silhouette**.

---

## Using it

1. Connect your Silhouette by USB and switch it on. The panel header shows the
   model with a green dot when it finds one.
2. Select the artwork you want to cut. With nothing selected, the whole artboard
   is used.
3. Choose your material. That sets blade pressure, speed and depth on the
   machine; the coloured dot is the blade cap Silhouette recommends.
4. Press **Preview** to see exactly what the machine would cut. This never moves
   the machine, so it's always safe.
5. Press **Send to Silhouette**.

**Before your first real cut:** tick *Bounding box only* and run it on scrap.
It traces just the outline of your design, which tells you the placement is
right before you commit an expensive sheet.

## If something goes wrong

**The panel isn't in the Extensions menu.** Illustrator only scans for
extensions at launch — quit it completely (⌘Q, not just closing the window) and
reopen. If it's still missing, the extension didn't install; try installing the
`.zxp` again.

**"The helper is running on Python …, which cannot reach USB".** The panel found
a Python that's missing its USB support. Install Python from
[python.org](https://www.python.org/downloads/) and reopen the panel.

**"No cutter found" with the machine plugged in.** Check it's switched on and
that Silhouette Studio isn't currently connected to it — only one program can
talk to the machine at a time. Then press ↻ in the panel. You can still use
**Dry run** to check a design without hardware.

**The cut is in the wrong place.** Different Silhouette models offset cuts by
their own media margins; the panel tells you when yours does. Use the Offset X
and Y fields to correct it, and check with *Bounding box only* on scrap.

**Something was skipped.** The panel lists what it couldn't cut. Placed images,
symbols, blends and envelopes have no path geometry to follow — select them and
use **Object → Expand** first. Text is outlined automatically, and your artwork
is never modified.

## Uninstalling

Remove it with the same ZXP installer you used to install it, or delete the
extension folder directly:

```bash
rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.samwinslet.cameo-illustrator"
```

Then quit Illustrator completely and reopen it.
