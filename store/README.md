# Publishing the extension to the Chrome Web Store

Everything the store asks for is in this folder: listing copy and privacy answers (`listing.md`), the privacy policy (`privacy.md`) and images (`assets/`).

## Before the first submission

1. **The headsup app must be installable by someone else.** The extension only shows "not connected" without it, and a reviewer can't use a private repo. Publish `headsup-ai` 0.x to npm (or make the repo public) first.
2. **Host the privacy policy at a public URL.** Any static page with the contents of `privacy.md` works.
3. **Developer account.** Register at https://chrome.google.com/webstore/devconsole. There's a one-time registration fee, and the account needs 2-step verification.

## Uploading

```sh
pnpm pack:ext   # → dist-ext/headsup-extension-<version>.zip, without the "key" field
```

1. In the dashboard: **New item** → upload the zip.
2. Fill **Store listing**, **Privacy practices** and **Test instructions** from `listing.md`.
3. **Distribution → Visibility: Unlisted** for the beta (installable by link, auto-updates, not searchable). Switch to Public at launch.
4. Submit for review.

## After the first upload: one extension ID

The store gives the item its own ID, different from the one unpacked installs get from the `key` in `extension/manifest.json`. Make them the same so the app trusts one ID everywhere:

1. Dashboard → the item → **Package** → **View public key**. Copy the key without the BEGIN/END lines.
2. Replace `"key"` in `extension/manifest.json` with it.
3. In `src/native.ts`, set `EXTENSION_ID` to the store ID and move the old one (`heomldlmknjaidfkfkdhjibppainocea`) into `EARLIER_EXTENSION_IDS`, so existing installs keep working.
4. `pnpm test` (it checks that the ID matches the key), then run `headsup connect-browser` again.

## Each update

Bump `version` in `extension/manifest.json`, run `pnpm pack:ext`, and upload the new zip under **Package**. Installed copies update on their own after review.
