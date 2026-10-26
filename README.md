# FAFO Match

One screen for two jobs the toolbox used to split apart:

- **Copies** — the bytes match, so one file can go.
- **Pairs** — the same shot at two sizes, including an upscale whose name no longer matches.

Review with a wipe, side by side, or a difference view. Lock the pair or mark it as not a pair. Export a keep / trash list.

Nothing is uploaded. The server binds to `127.0.0.1:18766` and exits about 90 seconds after the page stops pinging.

## Install on this PC

From PowerShell:

```powershell
irm https://raw.githubusercontent.com/Treyu2023/FAFO-Match/main/Install.ps1 | iex
```

That downloads or updates [FAFO Match](https://github.com/Treyu2023/FAFO-Match) at `C:\_git\FAFO-Match` and puts two shortcuts on the Desktop: **FAFO Match** and **Update FAFO Match**. It does not download or change the toolbox. Run it again any time. It will not delete a folder that is already there.

## Start

Double-click **Start FAFO Match.bat**.

Or:

```bat
py -3 server\match_server.py
```

Then open `http://127.0.0.1:18766/`.

Paste a folder path and scan. If `ffmpeg` is on PATH, renamed upscales pair from the picture. Without ffmpeg, drop the files and the page reads the frames itself.

**Recycle the copies** sends the extras to the Windows recycle bin. It only accepts files inside a folder you scanned in this session.

## What this replaces

In the FAFO Power Toolbox this is the single path instead of bouncing between the duplicate manager, the mismatched-name tool, the pair queue, and the video comparator.
