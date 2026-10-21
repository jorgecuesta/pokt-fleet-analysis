# Publish the neutral branding update

Prepared 21 October 2026 against GitHub commit `93ff101`.

The product is now named **Fleet Observatory**. Its header, favicon, browser
titles, footer, metadata, README, notebook headings and packaging use independent
branding. The original Pocket wordmark is removed. A generic geometric mark
replaces it. Source references, historical service IDs and payment units remain
accurate; no earnings or selection calculations were changed.

## Apply the update with GitHub Desktop

1. Open GitHub Desktop and select your existing `pokt-fleet-analysis` repository.
2. Click **Fetch origin**, then **Pull origin** if offered. Finish or save any
   unrelated local changes first. This update was prepared from commit `93ff101`;
   if newer source changes exist, review the included patch instead of replacing
   those changes blindly.
3. Download `fleet_observatory_branding_update.zip`, right-click it and choose
   **Extract All**. Open the extracted folder. Open its **repository-files** folder.
4. Inside **repository-files**, select all its contents and copy them.
5. In GitHub Desktop choose **Repository → Show in Explorer**. This opens your
   existing repository folder, with `package.json` directly inside it. Paste the
   copied files here and choose **Replace the files in the destination**. Windows
   merges the supplied directories; they contain only changed files.
6. In that repository, open `src`, then `assets`. Delete the old file
   `pocket-logo-white.png`. Keep `fleet-mark.svg` and the font files.
7. Return to GitHub Desktop. Review **Changes**. The list should include the
   deleted old wordmark, the new generic SVG and the changed source/build files.
8. Enter **Use independent Fleet Observatory branding** as the commit summary.
   Click **Commit to main** (or your current branch), then **Push origin**.
9. In GitHub, wait for **Verify fleet analysis** to pass. In Vercel, wait for the
   deployment for this commit to show **Ready**. The connected project should
   deploy automatically if its existing Git integration is enabled. If not, select
   the new commit and deploy it through the existing Vercel project.
10. Open the production URL and hard-refresh with **Ctrl+F5**. Check the header,
    footer, browser tab/favicon and **About the data**, then open a fleet and
    `?dataset=preview`. Both modes should say Fleet Observatory and use the new mark.

The provided `dist/index.html` is rebuilt. Your existing settlement binary and
saved data files are reused; do not delete them. A binary-safe Git patch is also
included for developers who prefer applying the changes with Git.

## GitHub and Vercel account labels

These settings live in your accounts, not in the repository files:

- GitHub repository page → **About** gear: set the description to
  **Independent historical Supplier fleet analysis and selection modelling**.
  Remove any affiliation wording or custom branded social-preview image, if set.
- Vercel project → **Settings → General**: you may set its display name to
  `fleet-observatory`. Keep the existing working production URL and Git connection.
  Changing a project name, URL or repository slug is not required to replace the
  product branding; handle URL changes separately to avoid breaking shared links.

## Scope and validation

This is prepared source, not a claim that your public accounts were updated.
All 80 JavaScript and 101 Python tests passed. Build and bundle/schema checks
passed (134 example reports plus 33 recorded reports). The saved earnings and
selection data are unchanged. A rendered desktop/mobile review remains required.

Old Git commits, earlier Vercel deployments and previously shared documents can
still contain the former branding. This update changes the current source and
next deployment; it does not rewrite history or revise old PDFs/presentations.
