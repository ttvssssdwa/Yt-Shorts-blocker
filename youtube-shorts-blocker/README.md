# YouTube Shorts Blocker

A small Chrome extension that hides YouTube Shorts entry points and blocks navigation to `/shorts/` pages.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

   `C:\Users\mrttv\Documents\New project\youtube-shorts-blocker`

## What it blocks

- Shorts links in the sidebar, mini guide, tabs, feeds, search results, and shelves.
- Clicks, middle-clicks, and YouTube single-page-app navigations to Shorts URLs.
- Direct visits to `youtube.com/shorts/...`, which are redirected to the YouTube home page.
- Transient YouTube video player errors like "An error occurred", which trigger 1 automatic reload per video after the error stays visible for a few seconds.
- Automatic error reloads are skipped while the player is fullscreen.

If YouTube changes its markup, reload the extension from `chrome://extensions` after editing `content.js` or `styles.css`.

When updating this unpacked extension, click the reload icon for it on `chrome://extensions`, then refresh any open YouTube tabs so Chrome injects the newest content script.
