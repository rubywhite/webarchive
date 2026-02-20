const USER_AGENT = "WebArchiveShare/1.0";
const DEFAULT_TITLE = "Web Archive Reader";
const DEFAULT_DESCRIPTION = "Open a clean cached reader view from the Internet Archive.";

function html(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
    body,
  };
}

function normalizeText(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (!maxLength) return normalized;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function isHttpUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function toAbsoluteUrl(input, base) {
  if (!input) return "";
  try {
    return new URL(input, base).toString();
  } catch (error) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveOrigin(event) {
  const headers = event.headers || {};
  const proto =
    String(headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https")
      .split(",")[0]
      .trim() || "https";
  const host = String(headers["x-forwarded-host"] || headers.host || "")
    .split(",")[0]
    .trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

function extractCacheKeyFromEvent(event) {
  const candidates = [];
  if (event?.path) candidates.push(event.path);
  if (event?.rawUrl) candidates.push(event.rawUrl);
  if (event?.rawPath) candidates.push(event.rawPath);

  const headers = event?.headers || {};
  const headerKeys = [
    "x-nf-original-path",
    "x-original-uri",
    "x-forwarded-uri",
    "x-rewrite-url",
  ];
  headerKeys.forEach((key) => {
    const value = headers[key] || headers[key.toUpperCase()];
    if (value) candidates.push(String(value));
  });

  for (const candidate of candidates) {
    const match = String(candidate).match(/\/s\/([^/?#]+)/);
    if (!match || !match[1]) continue;
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return match[1];
    }
  }
  return "";
}

async function fetchMetadata(origin, targetUrl) {
  if (!origin || !isHttpUrl(targetUrl)) return null;
  try {
    const response = await fetch(
      `${origin}/.netlify/functions/archive?url=${encodeURIComponent(targetUrl)}`,
      {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.status !== "archived") return null;
    return {
      title: normalizeText(data.title, 180),
      excerpt: normalizeText(data.excerpt || data.byline, 280),
      image: data.heroImage || "",
    };
  } catch (error) {
    return null;
  }
}

function buildReaderUrl(origin, targetUrl, cacheKey) {
  if (!origin || !isHttpUrl(targetUrl)) return origin || "/";
  const reader = new URL("/reader.html", origin);
  reader.searchParams.set("url", targetUrl);
  if (cacheKey) {
    reader.searchParams.set("cache", cacheKey);
  }
  return reader.toString();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return html(405, "<!doctype html><html><body>Method not allowed.</body></html>");
  }

  const origin = resolveOrigin(event);
  const params = event.queryStringParameters || {};
  const cacheKey = normalizeText(params.cache || extractCacheKeyFromEvent(event) || "", 100);
  const originalUrl = normalizeText(params.url || "", 3000);

  const readerUrl = buildReaderUrl(origin, originalUrl, cacheKey);

  let title = normalizeText(params.title || "", 180);
  let description = normalizeText(params.excerpt || "", 280);
  let image = normalizeText(params.image || "", 3000);

  if ((!title || !description || !image) && isHttpUrl(originalUrl)) {
    const fetched = await fetchMetadata(origin, originalUrl);
    if (fetched) {
      if (!title) title = fetched.title;
      if (!description) description = fetched.excerpt;
      if (!image) image = fetched.image;
    }
  }

  const safeTitle = title || DEFAULT_TITLE;
  const safeDescription = description || DEFAULT_DESCRIPTION;
  const fallbackImage = origin ? `${origin}/RubyWhite.png` : "/RubyWhite.png";
  const safeImage = isHttpUrl(image) ? image : toAbsoluteUrl(image, origin) || fallbackImage;
  const safeReaderUrl = isHttpUrl(readerUrl) ? readerUrl : origin || "/";
  const safeShareUrl = safeReaderUrl;

  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(safeTitle)}</title>
    <meta name="description" content="${escapeHtml(safeDescription)}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(safeTitle)}" />
    <meta property="og:description" content="${escapeHtml(safeDescription)}" />
    <meta property="og:image" content="${escapeHtml(safeImage)}" />
    <meta property="og:url" content="${escapeHtml(safeShareUrl)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(safeTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(safeDescription)}" />
    <meta name="twitter:image" content="${escapeHtml(safeImage)}" />
    <meta http-equiv="refresh" content="0;url=${escapeHtml(safeReaderUrl)}" />
    <script>window.location.replace(${JSON.stringify(safeReaderUrl)});</script>
  </head>
  <body>
    <p>Redirecting to the clean archive view...</p>
    <p><a href="${escapeHtml(safeReaderUrl)}">Continue</a></p>
  </body>
</html>`;

  return html(200, page);
};
