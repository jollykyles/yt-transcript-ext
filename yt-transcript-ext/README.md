# YouTube Transcript Grabber (Chrome Extension)

Paste a YouTube URL (or open the popup while watching a video — it auto-fills)
and get the video's transcript.

**Subtitle priority:**
1. User-created (manual) subtitles — English preferred, otherwise the first manual track
2. English auto-generated (ASR) captions
3. If neither exists, it tells you which languages *are* available

## Install (unpacked)

1. Unzip this folder somewhere permanent (Chrome loads it from disk each launch).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the icon from the puzzle-piece menu if you want it on the toolbar.

## Use

- Click the icon, paste a URL (watch, youtu.be, shorts, embed, or a bare 11-char video ID all work), hit **Fetch** or Enter.
- The badge in the header tells you whether you got **Manual** or **Auto-generated** captions and which track.
- Toggle **Timestamps** on/off, then **Copy** or **Save .txt**.

## How it works (no yt-dlp, no Python)

The extension fetches the video's watch page directly (host permissions bypass
CORS), parses the `ytInitialPlayerResponse` JSON embedded in the HTML, reads the
`captionTracks` list, picks a track by the priority above, and downloads the
transcript via YouTube's internal InnerTube get_transcript API — the same
endpoint the site's own "Show transcript" button uses — so no proof-of-origin
token is needed. Legacy timedtext (json3/XML) is kept as an automatic fallback.

## If it breaks someday

YouTube changes its internals periodically. Symptoms and likely fixes:

- **"Couldn't read the player data"** — YouTube renamed/moved
  `ytInitialPlayerResponse`. The marker string in `extractPlayerResponse()`
  in `popup.js` needs updating.
- **"YouTube returned an empty caption response"** — YouTube has been
  experimenting with requiring a proof-of-origin ("pot") token on caption URLs
  for some clients. If this starts happening consistently, the fix is to fetch
  captions via YouTube's InnerTube API instead; the track-selection logic stays
  the same.
