const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const USER_AGENT = "WebArchive/1.0";
const ARCHIVE_ORIGIN = "https://web.archive.org";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function isHttpUrl(input) {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
}

function absolutizeUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch (error) {
    return value;
  }
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function toDateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function findDateInJsonLd(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDateInJsonLd(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const keys = [
    "datePublished",
    "dateCreated",
    "dateModified",
    "date",
    "pubDate",
    "published",
  ];
  for (const key of keys) {
    if (value[key]) {
      const candidate = toDateOnly(value[key]);
      if (candidate) return candidate;
    }
  }
  if (value["@graph"]) {
    return findDateInJsonLd(value["@graph"]);
  }
  for (const key of Object.keys(value)) {
    const nested = findDateInJsonLd(value[key]);
    if (nested) return nested;
  }
  return null;
}

function extractPublishedDate(document) {
  const metaSelectors = [
    { selector: 'meta[property="article:published_time"]', attr: "content" },
    { selector: 'meta[property="og:published_time"]', attr: "content" },
    { selector: 'meta[name="article:published_time"]', attr: "content" },
    { selector: 'meta[name="pubdate"]', attr: "content" },
    { selector: 'meta[name="publish-date"]', attr: "content" },
    { selector: 'meta[name="publish_date"]', attr: "content" },
    { selector: 'meta[name="date"]', attr: "content" },
    { selector: 'meta[name="dc.date"]', attr: "content" },
    { selector: 'meta[name="dc.date.issued"]', attr: "content" },
    { selector: 'meta[name="dc.date.published"]', attr: "content" },
    { selector: 'meta[name="datePublished"]', attr: "content" },
    { selector: 'meta[name="parsely-pub-date"]', attr: "content" },
    { selector: 'meta[name="sailthru.date"]', attr: "content" },
    { selector: 'meta[property="article:published"]', attr: "content" },
  ];

  for (const { selector, attr } of metaSelectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const value = node.getAttribute(attr);
    const candidate = toDateOnly(value);
    if (candidate) return candidate;
  }

  const timeNode =
    document.querySelector("time[datetime]") ||
    document.querySelector('time[itemprop="datePublished"]') ||
    document.querySelector("time[pubdate]");
  if (timeNode) {
    const value = timeNode.getAttribute("datetime") || timeNode.textContent;
    const candidate = toDateOnly(value);
    if (candidate) return candidate;
  }

  const itemProp = document.querySelector('[itemprop="datePublished"]');
  if (itemProp) {
    const value = itemProp.getAttribute("content") || itemProp.textContent;
    const candidate = toDateOnly(value);
    if (candidate) return candidate;
  }

  const jsonLdScripts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  );
  for (const script of jsonLdScripts) {
    const text = script.textContent || "";
    if (!text.trim()) continue;
    try {
      const parsed = JSON.parse(text);
      const candidate = findDateInJsonLd(parsed);
      if (candidate) return candidate;
    } catch (error) {
      // ignore invalid JSON-LD
    }
  }

  return null;
}

function extractSiteName(document) {
  const selectors = [
    { selector: 'meta[property="og:site_name"]', attr: "content" },
    { selector: 'meta[name="application-name"]', attr: "content" },
    { selector: 'meta[name="apple-mobile-web-app-title"]', attr: "content" },
    { selector: 'meta[name="twitter:site"]', attr: "content" },
  ];

  for (const { selector, attr } of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const value = normalizeText(node.getAttribute(attr));
    if (!value) continue;
    const cleaned = value.startsWith("@") ? value.slice(1) : value;
    if (cleaned) {
      return cleaned;
    }
  }
  return "";
}

function fallbackSiteNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const base = parts.length >= 2 ? parts[parts.length - 2] : host;
    const words = base
      .split(/[-_]+/)
      .filter(Boolean)
      .map((word) => {
        if (word.length <= 4) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
      });
    return words.join(" ") || host;
  } catch (error) {
    return "";
  }
}

function stripWaybackPrefix(url) {
  if (!url) return "";
  return url.replace(/^https?:\/\/web\.archive\.org\/web\/\d{14}[a-z]{0,2}_?\//, "");
}

function buildArchiveUrl(absoluteUrl, timestamp, modifier) {
  if (!timestamp) return absoluteUrl;
  if (absoluteUrl.startsWith(`${ARCHIVE_ORIGIN}/web/`)) {
    if (!modifier) {
      return absoluteUrl;
    }
    const match = absoluteUrl.match(/\/web\/(\d{14})([a-z]{2}_)?\//);
    if (!match) return absoluteUrl;
    if (match[2] === `${modifier}_`) {
      return absoluteUrl;
    }
    return absoluteUrl.replace(match[0], `/web/${match[1]}${modifier}_/`);
  }
  const suffix = modifier ? `${modifier}_` : "";
  const safeUrl = encodeURI(absoluteUrl);
  return `${ARCHIVE_ORIGIN}/web/${timestamp}${suffix}/${safeUrl}`;
}

function rewriteSrcset(value, baseUrl, timestamp, modifier) {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const pieces = trimmed.split(/\s+/);
      const url = pieces.shift();
      const absolute = absolutizeUrl(url, baseUrl);
      const archived = buildArchiveUrl(absolute, timestamp, modifier);
      return [archived, ...pieces].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanContent(html, baseUrl, timestamp) {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const { document } = dom.window;

  document.querySelectorAll("noscript").forEach((el) => {
    const text = el.textContent || "";
    if (text.includes("<img") || text.includes("<picture")) {
      const fragment = JSDOM.fragment(text);
      el.replaceWith(fragment);
    } else {
      el.remove();
    }
  });

  document.querySelectorAll("script, style, iframe").forEach((el) => {
    el.remove();
  });

  document.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:") || src === "about:blank") {
      const dataSrc =
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-orig-src");
      if (dataSrc) {
        img.setAttribute("src", dataSrc);
      }
    }
    const srcset = img.getAttribute("srcset");
    if (!srcset) {
      const dataSrcset =
        img.getAttribute("data-srcset") ||
        img.getAttribute("data-original-srcset") ||
        img.getAttribute("data-lazy-srcset");
      if (dataSrcset) {
        img.setAttribute("srcset", dataSrcset);
      }
    }
  });

  document.querySelectorAll("source").forEach((source) => {
    const srcset = source.getAttribute("srcset");
    if (!srcset) {
      const dataSrcset =
        source.getAttribute("data-srcset") ||
        source.getAttribute("data-original-srcset") ||
        source.getAttribute("data-lazy-srcset");
      if (dataSrcset) {
        source.setAttribute("srcset", dataSrcset);
      }
    }
  });

  document.querySelectorAll("picture").forEach((picture) => {
    const img = picture.querySelector("img");
    if (!img) return;
    const imgSrc = img.getAttribute("src");
    if (imgSrc && !imgSrc.startsWith("data:") && imgSrc !== "about:blank") {
      return;
    }
    const source = picture.querySelector("source[srcset], source[data-srcset]");
    if (!source) return;
    const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset");
    if (!srcset) return;
    const first = srcset.split(",")[0]?.trim();
    if (!first) return;
    const url = first.split(/\s+/)[0];
    if (url) {
      img.setAttribute("src", url);
    }
  });

  const urlAttributes = [
    { selector: "img", attr: "src", modifier: "im" },
    { selector: "img", attr: "srcset", isSrcset: true, modifier: "im" },
    { selector: "source", attr: "src", modifier: "im" },
    { selector: "source", attr: "srcset", isSrcset: true, modifier: "im" },
    { selector: "a", attr: "href" },
    { selector: "video", attr: "src", modifier: "id" },
    { selector: "audio", attr: "src", modifier: "id" },
    { selector: "track", attr: "src", modifier: "id" },
  ];

  urlAttributes.forEach(({ selector, attr, isSrcset, modifier }) => {
    document.querySelectorAll(selector).forEach((node) => {
      const value = node.getAttribute(attr);
      if (!value) return;
      if (isSrcset) {
        node.setAttribute(attr, rewriteSrcset(value, baseUrl, timestamp, modifier));
        return;
      }
      const absolute = absolutizeUrl(value, baseUrl);
      node.setAttribute(attr, buildArchiveUrl(absolute, timestamp, modifier));
    });
  });

  document.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src) return;
    const srcset = img.getAttribute("srcset");
    if (!srcset) return;
    const first = srcset.split(",")[0]?.trim();
    if (!first) return;
    const url = first.split(/\s+/)[0];
    if (url) {
      img.setAttribute("src", url);
    }
  });

  return document.body.innerHTML;
}

function extractHeroImageSource(document, baseUrl) {
  const selectors = [
    { selector: 'meta[property="og:image"]', attr: "content" },
    { selector: 'meta[property="og:image:url"]', attr: "content" },
    { selector: 'meta[property="og:image:secure_url"]', attr: "content" },
    { selector: 'meta[name="twitter:image"]', attr: "content" },
    { selector: 'meta[name="twitter:image:src"]', attr: "content" },
    { selector: 'meta[name="thumbnail"]', attr: "content" },
    { selector: 'link[rel="image_src"]', attr: "href" },
  ];

  for (const { selector, attr } of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const value = node.getAttribute(attr);
    if (!value) continue;
    const absolute = absolutizeUrl(value, baseUrl);
    if (!isValidHttpUrl(absolute)) continue;
    return absolute;
  }
  return null;
}

function normalizeUrlForCompare(value) {
  const stripped = stripWaybackPrefix(value);
  try {
    const parsed = new URL(stripped);
    parsed.hash = "";
    parsed.search = "";
    let path = parsed.pathname || "";
    if (path !== "/") {
      path = path.replace(/\/+$/, "");
    }
    return `${parsed.origin}${path}`.toLowerCase();
  } catch (error) {
    return stripped.toLowerCase();
  }
}

function getUrlBasename(value) {
  try {
    const parsed = new URL(stripWaybackPrefix(value));
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return (last || "").toLowerCase();
  } catch (error) {
    return "";
  }
}

function collectImageCandidatesFromNode(node) {
  const values = [];
  const directAttrs = [
    "src",
    "data-src",
    "data-original",
    "data-lazy-src",
    "data-orig-src",
    "content",
  ];
  directAttrs.forEach((attr) => {
    const value = node.getAttribute(attr);
    if (value) values.push(value);
  });
  const srcsetAttrs = [
    "srcset",
    "data-srcset",
    "data-original-srcset",
    "data-lazy-srcset",
  ];
  srcsetAttrs.forEach((attr) => {
    const srcset = node.getAttribute(attr);
    if (!srcset) return;
    srcset
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
      .forEach((url) => values.push(url));
  });
  return values;
}

function extractFigureCaption(figure) {
  if (!figure) return "";
  const captionNode = figure.querySelector(
    "figcaption, [itemprop='caption'], [class*='caption']"
  );
  return normalizeText(captionNode?.textContent || "");
}

function buildFigureCaptionIndex(document, baseUrl) {
  const byNormalized = new Map();
  const basenameCandidates = new Map();
  let firstFigureImageUrl = "";

  Array.from(document.querySelectorAll("figure")).forEach((figure) => {
    const caption = extractFigureCaption(figure);
    const imageNodes = figure.querySelectorAll("img, source, meta[itemprop='url']");
    imageNodes.forEach((imageNode) => {
      const candidates = collectImageCandidatesFromNode(imageNode);
      candidates.forEach((candidate) => {
        const absolute = absolutizeUrl(candidate, baseUrl);
        if (!isValidHttpUrl(stripWaybackPrefix(absolute))) return;
        if (!firstFigureImageUrl) {
          firstFigureImageUrl = absolute;
        }
        if (!caption) return;
        const normalized = normalizeUrlForCompare(absolute);
        const basename = getUrlBasename(absolute);
        if (normalized && !byNormalized.has(normalized)) {
          byNormalized.set(normalized, caption);
        }
        if (basename) {
          if (!basenameCandidates.has(basename)) {
            basenameCandidates.set(basename, new Set());
          }
          basenameCandidates.get(basename).add(caption);
        }
      });
    });
  });

  const byBasename = new Map();
  basenameCandidates.forEach((captions, basename) => {
    if (captions.size === 1) {
      byBasename.set(basename, Array.from(captions)[0]);
    }
  });

  return { byNormalized, byBasename, firstFigureImageUrl };
}

function findCaptionForUrl(value, baseUrl, captionIndex) {
  if (!value || !captionIndex) return "";
  const absolute = absolutizeUrl(value, baseUrl);
  const normalized = normalizeUrlForCompare(absolute);
  if (normalized && captionIndex.byNormalized.has(normalized)) {
    return captionIndex.byNormalized.get(normalized);
  }
  const basename = getUrlBasename(absolute);
  if (basename && captionIndex.byBasename.has(basename)) {
    return captionIndex.byBasename.get(basename);
  }
  return "";
}

function findCaptionForFigure(figure, baseUrl, captionIndex) {
  if (!figure || !captionIndex) return "";
  const imageNodes = figure.querySelectorAll("img, source, meta[itemprop='url']");
  for (const imageNode of imageNodes) {
    const candidates = collectImageCandidatesFromNode(imageNode);
    for (const candidate of candidates) {
      const caption = findCaptionForUrl(candidate, baseUrl, captionIndex);
      if (caption) return caption;
    }
  }
  return "";
}

function enrichContentWithFigureCaptions(contentHtml, baseUrl, captionIndex) {
  if (!contentHtml || !captionIndex) return contentHtml;
  const dom = new JSDOM(`<body>${contentHtml}</body>`);
  const { document } = dom.window;

  document.querySelectorAll("figure").forEach((figure) => {
    if (extractFigureCaption(figure)) return;
    const caption = findCaptionForFigure(figure, baseUrl, captionIndex);
    if (!caption) return;
    const figcaption = document.createElement("figcaption");
    figcaption.textContent = caption;
    figure.appendChild(figcaption);
  });

  document.querySelectorAll("img").forEach((img) => {
    if (img.closest("figure")) return;
    const candidates = collectImageCandidatesFromNode(img);
    for (const candidate of candidates) {
      const caption = findCaptionForUrl(candidate, baseUrl, captionIndex);
      if (!caption) continue;
      const next = img.nextElementSibling;
      if (next && normalizeText(next.textContent || "") === caption) {
        break;
      }
      const paragraph = document.createElement("p");
      paragraph.className = "image-caption";
      paragraph.textContent = caption;
      img.insertAdjacentElement("afterend", paragraph);
      break;
    }
  });

  return document.body.innerHTML;
}

function extractFeaturedImageCaption(baseUrl, featuredImageSource, captionIndex) {
  if (!featuredImageSource) return "";
  return findCaptionForUrl(featuredImageSource, baseUrl, captionIndex);
}

function prependHeroImage(contentHtml, heroUrl, heroCaption) {
  if (!heroUrl) return contentHtml;
  const strippedHero = stripWaybackPrefix(heroUrl);
  if (contentHtml.includes(heroUrl) || contentHtml.includes(strippedHero)) {
    return contentHtml;
  }
  const captionMarkup = heroCaption
    ? `<figcaption>${escapeHtml(heroCaption)}</figcaption>`
    : "";
  return `<figure class="reader-hero"><img src="${heroUrl}" alt="" />${captionMarkup}</figure>${contentHtml}`;
}

function stripInlineHandlers(document) {
  document.querySelectorAll("*").forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      if (attr.name.toLowerCase().startsWith("on")) {
        node.removeAttribute(attr.name);
      }
    });
  });
}

async function fetchArchiveHtml(archiveUrl, targetUrl, timestamp) {
  const candidates = [];
  if (timestamp) {
    candidates.push(buildArchiveUrl(targetUrl, timestamp, "id"));
  }
  candidates.push(archiveUrl);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) {
        lastError = {
          status: response.status,
          statusText: response.statusText,
          url: candidate,
        };
        continue;
      }
      const html = await response.text();
      return { html, sourceUrl: candidate };
    } catch (error) {
      lastError = { message: error.message, url: candidate };
    }
  }

  return { error: lastError };
}

async function lookupCdxSnapshot(targetUrl) {
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
    targetUrl
  )}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&limit=1&sort=descending`;

  try {
    const response = await fetch(cdxUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) {
      return null;
    }
    const row = data[1];
    const timestamp = row[0];
    const original = row[1] || targetUrl;
    if (!timestamp) {
      return null;
    }
    return {
      url: buildArchiveUrl(original, timestamp, null),
      timestamp,
      original,
    };
  } catch (error) {
    return null;
  }
}

function extractTimestamp(archiveUrl, fallbackTimestamp) {
  if (fallbackTimestamp && /^\d{14}$/.test(fallbackTimestamp)) {
    return fallbackTimestamp;
  }
  const match = archiveUrl.match(/\/web\/(\d{14})/);
  return match ? match[1] : null;
}

function normalizeSaveDetail(text) {
  if (!text) return "";
  const stripped = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const maxLength = 600;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 3)}...` : stripped;
}

function classifySaveFailure(status, detail) {
  const lower = (detail || "").toLowerCase();
  if (lower.includes("robots.txt")) {
    return { category: "robots", label: "Blocked by robots.txt" };
  }
  if (lower.includes("access is forbidden") || status === 403) {
    return { category: "forbidden", label: "Access forbidden" };
  }
  if (lower.includes("unavailable for archiving") || lower.includes("cannot be archived")) {
    return { category: "blocked", label: "Unavailable for archiving" };
  }
  if (lower.includes("rate limit") || status === 429) {
    return { category: "rate_limited", label: "Wayback rate limit" };
  }
  if (status === 401) {
    return { category: "unauthorized", label: "Unauthorized" };
  }
  if (status === 404) {
    return { category: "not_found", label: "Not found" };
  }
  if (status >= 500) {
    return { category: "service_error", label: "Wayback service error" };
  }
  if (lower.includes("blocked")) {
    return { category: "blocked", label: "Unavailable for archiving" };
  }
  return { category: "unknown", label: "Unavailable for archiving" };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const rawUrl = (event.queryStringParameters?.url || "").trim();
  if (!rawUrl) {
    return json(400, { error: "Missing url parameter." });
  }

  const parsed = isHttpUrl(rawUrl);
  if (!parsed) {
    return json(400, { error: "Please provide a valid http or https URL." });
  }
  parsed.hash = "";
  const targetUrl = parsed.href;

  const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;

  let availability;
  try {
    const availabilityRes = await fetch(availabilityUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!availabilityRes.ok) {
      return json(502, { error: "Wayback availability check failed." });
    }
    availability = await availabilityRes.json();
  } catch (error) {
    return json(502, { error: "Wayback availability check failed." });
  }

  const closest = availability?.archived_snapshots?.closest;

  let snapshot = null;
  let archiveSource = null;
  if (closest?.url) {
    snapshot = {
      url: closest.url,
      timestamp: closest.timestamp,
      original: closest.original || targetUrl,
    };
    archiveSource = "availability";
  } else {
    snapshot = await lookupCdxSnapshot(targetUrl);
    if (snapshot) {
      archiveSource = "cdx";
    }
  }

  if (!snapshot) {
    let archiveUrl = null;
    let submission = null;
    try {
      const saveRes = await fetch(`https://web.archive.org/save/${targetUrl}`, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT },
      });
      const detailText = normalizeSaveDetail(await saveRes.text().catch(() => ""));
      const classification = classifySaveFailure(saveRes.status, detailText);
      const contentLocation = saveRes.headers.get("content-location");
      if (contentLocation) {
        archiveUrl = `https://web.archive.org${contentLocation}`;
      }
      const shouldTreatAsBlocked =
        !saveRes.ok ||
        (detailText &&
          (classification.category !== "unknown" || detailText.includes("archiving")));
      if (shouldTreatAsBlocked) {
        submission = {
          ok: false,
          statusCode: saveRes.status,
          category: classification.category,
          label: classification.label,
          detail: detailText,
          message: `${classification.label}${saveRes.status ? ` (${saveRes.status})` : ""}`,
        };
      }
    } catch (error) {
      // Ignore failures here; we still report that submission was attempted.
    }

    if (submission) {
      return json(200, {
        status: "blocked",
        originalUrl: targetUrl,
        archiveUrl,
        submission,
        message: "Wayback could not archive this URL.",
      });
    }

    return json(200, {
      status: "submitted",
      originalUrl: targetUrl,
      archiveUrl,
      message: "This URL was not archived yet. A request to archive it has been submitted.",
    });
  }

  const archiveUrl = snapshot.url;
  const timestamp = extractTimestamp(archiveUrl, snapshot.timestamp);

  const { html, sourceUrl, error } = await fetchArchiveHtml(archiveUrl, targetUrl, timestamp);
  if (!html) {
    return json(502, {
      error: "Failed to fetch the archived page.",
      details: error,
    });
  }

  const baseUrl = sourceUrl || archiveUrl;
  const dom = new JSDOM(html, { url: baseUrl });
  stripInlineHandlers(dom.window.document);
  const figureCaptionIndex = buildFigureCaptionIndex(dom.window.document, baseUrl);
  const heroImageSource =
    extractHeroImageSource(dom.window.document, baseUrl) || figureCaptionIndex.firstFigureImageUrl;
  const heroImage = heroImageSource ? buildArchiveUrl(heroImageSource, timestamp, "im") : null;
  const heroCaption = extractFeaturedImageCaption(baseUrl, heroImageSource, figureCaptionIndex);
  const publicationName =
    extractSiteName(dom.window.document) || fallbackSiteNameFromUrl(targetUrl);
  const publishedDate = extractPublishedDate(dom.window.document);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.content) {
    return json(500, { error: "Could not extract readable content from the archive." });
  }

  let cleaned = cleanContent(article.content, baseUrl, timestamp);
  cleaned = enrichContentWithFigureCaptions(cleaned, baseUrl, figureCaptionIndex);
  cleaned = prependHeroImage(cleaned, heroImage, heroCaption);

  return json(200, {
    status: "archived",
    originalUrl: targetUrl,
    archiveUrl,
    title: article.title,
    byline: article.byline,
    excerpt: article.excerpt,
    contentHtml: cleaned,
    archiveSource,
    archiveTimestamp: timestamp,
    heroImage,
    publicationName,
    publishedDate,
  });
};
