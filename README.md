# Web Archive Reader

Web Archive Reader is a small Netlify application that checks whether a page has already been captured by the Internet Archive's Wayback Machine, extracts a clean reader view from the archived snapshot, and generates a compact share URL for the result.

The application is designed to work without a database or server-side cache. The frontend is a static site, the backend is a small set of Netlify Functions, and successful archive payloads are cached only in the browser with `localStorage`.

## What it does

- Accepts a user-supplied `http` or `https` URL.
- Checks whether the page already exists in Wayback.
- If needed, submits the page to Wayback for archiving.
- Extracts the readable article body from the archived snapshot.
- Preserves a clean reader URL and a compact share URL.
- Generates OG and Twitter metadata for the share URL.
- Generates a QR code for the reader share URL.
- Warns when the clean extraction is likely incomplete compared to the archived source.

## Stack

- Static frontend in `site/`
- Netlify Functions in `netlify/functions/`
- Node.js `18+`
- [`jsdom`](https://github.com/jsdom/jsdom) for DOM parsing and cleanup
- [`@mozilla/readability`](https://github.com/mozilla/readability) for article extraction

## Project structure

- `site/index.html`
  Homepage UI for URL submission and archive results.
- `site/app.js`
  Frontend controller for archive lookup, local caching, share-link creation, and homepage rendering.
- `site/reader.html`
  Dedicated clean reader page.
- `site/reader.js`
  Frontend controller for reader rendering, cache reuse, QR generation, and browser-side metadata updates.
- `site/styles.css`
  Shared styling for both pages.
- `netlify/functions/archive.js`
  Core serverless function that finds archived snapshots, extracts readable content, and returns structured JSON.
- `netlify/functions/share.js`
  Share-preview endpoint that emits OG and Twitter metadata and immediately redirects to the real reader page.
- `netlify/functions/og-image.js`
  Safe image proxy used by share previews.
- `netlify.toml`
  Netlify build and redirect configuration.
- `package.json`
  Function runtime dependencies and Node version.

## High-level architecture

The application has two layers:

1. A static browser frontend in `site/`
2. A serverless backend in `netlify/functions/`

The frontend is responsible for:

- collecting the input URL
- calling the archive function
- rendering either a preview, a warning, or a fallback message
- writing successful results to `localStorage`
- building the clean reader URL
- building the compact share URL
- copying the share URL to the clipboard
- showing a QR code for the share URL

The backend is responsible for:

- validating and normalizing input URLs
- trying multiple URL variants when a Wayback lookup fails
- querying Wayback availability and the CDX index
- optionally submitting a save request to Wayback
- fetching archived HTML snapshots
- extracting readable article content
- detecting hero images, captions, publication name, and published date
- deciding whether the extraction is likely incomplete
- generating shareable metadata
- proxying OG images safely for crawlers

There is no database. The only cache is browser-local. The `cache` value in a URL is a deterministic identifier used to keep clean share URLs stable and to let the same browser reuse the stored payload.

## End-to-end flow

### 1. Homepage submission

The user lands on `site/index.html` and submits a URL.

`site/app.js`:

- trims whitespace
- validates that the URL is `http` or `https`
- calls `/.netlify/functions/archive?url=...`

The archive function returns one of four main result types:

- `archived`
- `archived_link_only`
- `submitted`
- `blocked`

### 2. Archive lookup

`netlify/functions/archive.js` normalizes the incoming URL, removes the fragment, and builds a set of fallback URL variants.

These variants can include:

- the original URL
- a tracking-parameter-reduced URL
- a content-query-only URL
- the same path with and without a trailing slash
- the same hostname with and without `www`

This is important because the Wayback APIs sometimes succeed for one variant and fail for another.

### 3. Finding a snapshot

For each variant, `archive.js` attempts to locate a snapshot by:

- calling the Wayback availability API
- falling back to the CDX API if availability does not return a usable result

If no snapshot exists for the first variant, the function may submit the URL to:

- `https://web.archive.org/save/...`

If that succeeds, the frontend shows a `submitted` response and asks the user to try again later.

If the save attempt is blocked or denied, the function returns a structured `blocked` response with a classification such as:

- blocked by robots.txt
- forbidden
- unavailable for archiving
- rate limited

### 4. Fetching and extracting

Once a snapshot exists, `archive.js` fetches one or more archived HTML candidates and tries to extract the best readable result.

The extraction pipeline is:

- parse HTML with `JSDOM`
- suppress noisy CSS parsing errors from saved pages
- strip risky inline handlers
- build a figure-caption index from the archived DOM
- identify a likely hero image
- extract publication name and published date
- try Mozilla Readability
- clean the extracted HTML
- restore lazy-loaded images and `srcset`
- rewrite image, media, and link URLs so they continue to work against Wayback
- enrich missing captions
- fall back to a likely content node when Readability is too weak
- fall back again to JSON-LD article body when it is stronger than the main extraction

The function compares possible extractions and selects the strongest result using heuristics based on:

- extracted text length
- estimated coverage of the source page
- presence or absence of incompleteness warnings
- recency of the archived snapshot

### 5. Incomplete extraction warning

The function estimates whether the clean extraction is probably incomplete by comparing:

- extracted text length
- likely source article length
- total source body length

If the clean view seems much shorter than the archived source, the JSON response includes an `extractionWarning`. The frontend shows that warning on the homepage preview so users know to compare with the Wayback snapshot if necessary.

### 6. Homepage rendering and local cache

When the response status is `archived`, `site/app.js`:

- creates a deterministic cache key such as `wa-xxxxxx`
- stores the payload in `localStorage`
- builds a clean reader URL like `/reader.html?url=...&cache=wa-xxxxxx`
- builds a compact share URL like `/s/wa-xxxxxx?url=...&title=...`
- renders the extracted content directly on the homepage

The payload stored locally includes:

- title
- byline
- excerpt
- content HTML
- archive URL
- archive timestamp
- original URL
- hero image
- published date
- extraction warning

### 7. Reader page

`site/reader.html` is the dedicated reader experience.

`site/reader.js`:

- reads `url` and optional `cache` from the query string
- also reads the cache key from `/s/:cache` style paths
- checks `localStorage` first
- renders immediately if the payload already exists locally
- otherwise re-calls `/.netlify/functions/archive?url=...`

This means a shared link still works on a different device even though no server-side content cache exists.

### 8. Share URL

The public share URL is intentionally compact:

```text
/s/:cache?url=...&title=...
```

It is not the same as the reader page URL.

The reader page URL is the actual render target:

```text
/reader.html?url=...&cache=...
```

The share URL exists so social crawlers get a stable HTML page with proper metadata before the browser lands on the final reader page.

### 9. Share preview generation

`netlify/functions/share.js` handles `/s` and `/s/:cache`.

It:

- reads the cache key from the path or query string
- reads the original URL and optional title
- builds the actual reader destination URL
- optionally refetches metadata through `archive.js` if description or image data is missing
- emits OG and Twitter metadata
- immediately redirects to the reader page

This pattern keeps the share link human-friendly while still supporting social previews.

### 10. OG image proxy

Many social crawlers fail on raw Wayback image URLs or on double-wrapped image URLs. `netlify/functions/og-image.js` solves that by proxying the image.

It:

- accepts `?src=...`
- strips Wayback wrappers
- rejects invalid URLs
- rejects localhost and private-network SSRF targets
- follows a small number of redirects
- enforces timeout and size limits
- returns the image bytes directly
- falls back to a local image if fetching fails

## Netlify configuration

The current deployment model is built around Netlify and assumes the app is hosted at the domain root.

The required `netlify.toml` is:

```toml
[build]
  publish = "site"
  functions = "netlify/functions"

[[redirects]]
  from = "/s/:cache"
  to = "/.netlify/functions/share?cache=:cache"
  status = 200

[[redirects]]
  from = "/s"
  to = "/.netlify/functions/share"
  status = 200
```

### What this does

- publishes the static frontend from `site/`
- tells Netlify where the functions live
- rewrites share links into the share function

Without these redirects, `/s/...` links will not produce share previews correctly.

## What someone needs to customize for their own deployment

Anyone forking this repo for a new domain or organization should change the following.

### 1. Netlify build settings

In the Netlify UI, set:

- Base directory: blank unless the project is in a subfolder
- Build command: blank unless you add one
- Publish directory: `site`
- Functions directory: `netlify/functions`

The code does not currently require any environment variables.

### 2. Domain-specific metadata

The frontend currently includes hardcoded metadata for the original deployment domain. Update these values in:

- `site/index.html`
- `site/reader.html`

Look for values such as:

- `https://archive.rubywhite.com/`
- `https://archive.rubywhite.com/reader.html`
- `https://archive.rubywhite.com/RubyWhite.png`

If you leave those unchanged, default previews and fallback metadata will still point at the old deployment.

### 3. Branding assets and filenames

The current project uses these local images:

- `site/RubyWhite.png`
- `site/PANA256.svg`
- root `RubyWhite.png`

If you replace those assets or rename them, you must also update references in:

- `site/index.html`
- `site/reader.html`
- `netlify/functions/share.js`
- `netlify/functions/og-image.js`

Both functions currently use `/RubyWhite.png` as the fallback share image.

### 4. Footer text and external links

The current frontend includes project-specific attribution, GitHub links, and donation links. Update those in:

- `site/index.html`
- `site/reader.html`

### 5. Root-path deployment assumption

This code assumes deployment at the root of a domain.

Examples of root-relative paths used by the app:

- `/reader.html`
- `/s/...`
- `/.netlify/functions/archive`
- `/.netlify/functions/share`
- `/.netlify/functions/og-image`
- `/RubyWhite.png`

If you deploy under a subpath, you will need to update URL construction in:

- `site/app.js`
- `site/reader.js`
- `netlify/functions/share.js`
- `netlify/functions/og-image.js`
- `netlify.toml`

### 6. Share-route consistency

The frontend and Netlify redirects must stay aligned.

The following must agree with each other:

- the route shape generated in `site/app.js` and `site/reader.js`
- the redirect rules in `netlify.toml`
- the share function logic in `netlify/functions/share.js`

If you rename the share route, update all three places together.

### 7. Wayback-specific assumptions

The archive logic is tightly coupled to the Internet Archive.

The following assumptions are baked into the code:

- availability lookups use `archive.org`
- snapshots are fetched from `web.archive.org`
- snapshot URL rewriting assumes Wayback path formats such as `/web/<timestamp>/...`
- image rewriting assumes Wayback modifiers such as `im_` and `id_`

If someone wants to support a different archive backend, the main changes would be in:

- `netlify/functions/archive.js`
- `netlify/functions/share.js`
- `site/app.js`
- `site/reader.js`

## Local development

Install dependencies:

```bash
npm install
```

Run locally with the Netlify dev server:

```bash
netlify dev
```

Using `netlify dev` is important because it reproduces:

- static file serving
- function routing
- `/s/...` redirect behavior

## Operational notes

- There is no persistent backend storage.
- Cached article payloads exist only in the browser.
- Extraction is heuristic and will not succeed perfectly for every page.
- Some sites will only resolve to `archived_link_only`.
- Some pages may show an incomplete-extraction warning even when the visible result looks acceptable.
- `og-image.js` includes SSRF protections and size limits, but it still depends on third-party image servers being reachable.
- Netlify Function time limits matter. `archive.js` uses internal deadlines and fallback scoring to avoid running indefinitely.

## License

This project is distributed under GNU General Public License v3.0. See `COPYING.txt`.
