const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const USER_AGENT = "WebArchive/1.0";
const ARCHIVE_ORIGIN = "https://web.archive.org";
const PARSE_HTML_MAX_LENGTH = 3_000_000;
const HANDLER_DEADLINE_MS = 34_000;
const SNAPSHOT_FETCH_TIMEOUT_MS = 9_000;
const API_FETCH_TIMEOUT_MS = 4_500;
const DEADLINE_RESERVE_MS = 250;
const MIN_TIME_FOR_EXTRA_SNAPSHOT_MS = 4_000;

const JSDOM_VIRTUAL_CONSOLE = new VirtualConsole();
JSDOM_VIRTUAL_CONSOLE.on("jsdomError", (error) => {
  if (String(error?.message || "").includes("Could not parse CSS stylesheet")) {
    return;
  }
  console.error(error);
});

function sanitizeHtmlForDom(html) {
  if (!html) return "";
  return String(html)
    .slice(0, PARSE_HTML_MAX_LENGTH)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

function createDom(html, options = {}) {
  return new JSDOM(sanitizeHtmlForDom(html), {
    ...options,
    virtualConsole: JSDOM_VIRTUAL_CONSOLE,
  });
}

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

function deadlineRemainingMs(deadlineMs) {
  if (!deadlineMs) return Infinity;
  return deadlineMs - Date.now();
}

function isDeadlineExceeded(deadlineMs, reserveMs = 0) {
  return deadlineRemainingMs(deadlineMs) <= reserveMs;
}

async function fetchWithDeadline(
  url,
  options = {},
  { deadlineMs, timeoutMs = SNAPSHOT_FETCH_TIMEOUT_MS, reserveMs = DEADLINE_RESERVE_MS } = {}
) {
  const remaining = deadlineRemainingMs(deadlineMs) - reserveMs;
  if (remaining <= 0) {
    const error = new Error("Operation deadline exceeded.");
    error.code = "DEADLINE_EXCEEDED";
    throw error;
  }

  const safeTimeoutMs = Math.max(250, Math.min(timeoutMs, remaining));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(`Fetch timed out after ${safeTimeoutMs}ms.`);
      timeoutError.code = "FETCH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

function textLengthFromNode(node) {
  if (!node) return 0;
  return normalizeText(node.textContent || "").length;
}

function textLengthFromHtml(html) {
  if (!html) return 0;
  try {
    const dom = createDom(`<body>${html}</body>`);
    return textLengthFromNode(dom.window.document.body);
  } catch (error) {
    return 0;
  }
}

function textLengthFromDocumentBody(document) {
  if (!document?.body) return 0;
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, template").forEach((node) => node.remove());
  return textLengthFromNode(clone);
}

function pickLikelySourceArticleLength(document) {
  if (!document) return 0;
  const selectors = [
    "article",
    "[itemprop='articleBody']",
    "[data-testid*='article']",
    "main",
  ];

  let maxLength = 0;
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const length = textLengthFromNode(node);
      if (length > maxLength) {
        maxLength = length;
      }
    });
  });

  return maxLength;
}

function pickLikelySourceContentNode(document) {
  if (!document) return null;
  const primarySelectors = [
    "[itemprop='articleBody']",
    "article",
    "[data-testid*='article']",
    "main article",
  ];
  let bestNode = null;
  let bestLength = 0;
  primarySelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const length = textLengthFromNode(node);
      if (length > bestLength) {
        bestLength = length;
        bestNode = node;
      }
    });
  });

  if (bestNode) return bestNode;

  document.querySelectorAll("main").forEach((node) => {
    const length = textLengthFromNode(node);
    if (length > bestLength) {
      bestLength = length;
      bestNode = node;
    }
  });

  return bestNode;
}

function buildFallbackContentHtml(document, baseUrl, timestamp) {
  const node = pickLikelySourceContentNode(document);
  if (!node) return "";

  const clone = node.cloneNode(true);
  clone
    .querySelectorAll(
      [
        "script",
        "style",
        "noscript",
        "iframe",
        "form",
        "aside",
        "nav",
        "footer",
        "[aria-hidden='true']",
        "[class*='newsletter']",
        "[class*='subscribe']",
        "[class*='paywall']",
        "[class*='related']",
        "[class*='recommend']",
      ].join(", ")
    )
    .forEach((nodeToRemove) => nodeToRemove.remove());

  return cleanContent(clone.innerHTML || "", baseUrl, timestamp);
}

function buildExtractionWarning({
  extractedTextLength,
  sourceArticleLength,
  sourceBodyLength,
}) {
  const sourceLength = resolveSourceLength(sourceArticleLength, sourceBodyLength);
  if (!extractedTextLength || !sourceLength) return null;

  const coverage = extractedTextLength / sourceLength;
  const missingChars = sourceLength - extractedTextLength;
  const likelyIncomplete =
    sourceLength >= 3500 &&
    extractedTextLength >= 800 &&
    coverage < 0.58 &&
    missingChars > 1800;

  if (!likelyIncomplete) return null;

  return {
    kind: "possibly_incomplete",
    message:
      "This clean view may be incomplete. Compare with the Wayback snapshot link for the full page.",
    coverage: Number(coverage.toFixed(3)),
    extractedTextLength,
    sourceTextLength: sourceLength,
  };
}

function resolveSourceLength(sourceArticleLength, sourceBodyLength) {
  // Some pages expose only a truncated <article> while full text still exists elsewhere
  // in the saved DOM. If body text is much larger than the article node, use body length
  // as the baseline for completeness checks.
  let sourceLength = sourceArticleLength > 0 ? sourceArticleLength : sourceBodyLength || 0;
  if (
    sourceArticleLength > 0 &&
    sourceBodyLength > 0 &&
    sourceBodyLength >= 5000 &&
    sourceBodyLength > sourceArticleLength * 1.9
  ) {
    sourceLength = sourceBodyLength;
  }
  return sourceLength;
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

function findLongestArticleBodyInJsonLd(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    return value.reduce((best, item) => {
      const candidate = findLongestArticleBodyInJsonLd(item);
      return candidate.length > best.length ? candidate : best;
    }, "");
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object") return "";

  let best = "";
  const directKeys = ["articleBody", "text", "body"];
  directKeys.forEach((key) => {
    const raw = value[key];
    if (typeof raw === "string" && raw.length > best.length) {
      best = raw;
    } else if (raw && typeof raw === "object") {
      const nested = findLongestArticleBodyInJsonLd(raw);
      if (nested.length > best.length) {
        best = nested;
      }
    }
  });

  if (value["@graph"]) {
    const graphBody = findLongestArticleBodyInJsonLd(value["@graph"]);
    if (graphBody.length > best.length) {
      best = graphBody;
    }
  }

  Object.keys(value).forEach((key) => {
    if (directKeys.includes(key) || key === "@graph") return;
    const nested = findLongestArticleBodyInJsonLd(value[key]);
    if (nested.length > best.length) {
      best = nested;
    }
  });

  return best;
}

function articleBodyTextToHtml(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (!normalized) return "";

  let blocks = normalized
    .split(/\n{2,}/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  if (blocks.length <= 1) {
    blocks = normalized
      .split(/\n+/)
      .map((part) => normalizeText(part))
      .filter(Boolean);
  }
  if (blocks.length === 0) return "";

  return blocks.map((part) => `<p>${escapeHtml(part)}</p>`).join("");
}

function extractJsonLdArticleBodyHtml(document) {
  if (!document) return "";
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  let bestText = "";

  scripts.forEach((script) => {
    const raw = script.textContent || "";
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const candidate = findLongestArticleBodyInJsonLd(parsed);
      if (candidate.length > bestText.length) {
        bestText = candidate;
      }
    } catch (error) {
      // ignore invalid JSON-LD blocks
    }
  });

  const normalizedLength = normalizeText(bestText).length;
  if (normalizedLength < 1200) {
    return "";
  }
  return articleBodyTextToHtml(bestText);
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

function normalizeArchiveTargetUrl(value) {
  if (!value) return "";
  try {
    return new URL(value).toString();
  } catch (error) {
    return encodeURI(String(value));
  }
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
  const safeUrl = normalizeArchiveTargetUrl(absoluteUrl);
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
  const dom = createDom(`<body>${html}</body>`, { url: baseUrl });
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
  const dom = createDom(`<body>${contentHtml}</body>`);
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

function buildSnapshotVariantCandidates(archiveUrl, targetUrl, timestamp) {
  const variants = [{ url: archiveUrl, variant: "replay_snapshot" }];
  if (timestamp) {
    const idUrl = buildArchiveUrl(targetUrl, timestamp, "id");
    if (idUrl && idUrl !== archiveUrl) {
      variants.push({ url: idUrl, variant: "id_snapshot" });
    }
  }
  return variants;
}

function shouldTryAlternateVariant(extraction) {
  if (!extraction?._quality) return true;
  const quality = extraction._quality;
  const sourceLength = quality.sourceTextLength || 0;
  const extractedLength = quality.extractedTextLength || 0;
  const coverage = quality.coverage || 0;
  const missingChars = sourceLength - extractedLength;

  if (sourceLength <= 0) {
    return extractedLength < 4200;
  }

  if (coverage >= 0.68) return false;
  if (extractedLength >= 6000 && coverage >= 0.6) return false;
  if (missingChars <= 1400) return false;
  if (coverage < 0.5) return true;
  if (quality.hasWarning && coverage < 0.62 && missingChars > 1800) return true;
  return extractedLength < 3000;
}

async function fetchAndExtractVariant({
  targetUrl,
  timestamp,
  variant,
  sourceUrl,
  deadlineMs,
}) {
  if (isDeadlineExceeded(deadlineMs, DEADLINE_RESERVE_MS)) {
    return {
      error: {
        message: "Extraction deadline exceeded before snapshot fetch.",
        url: sourceUrl,
        variant,
        timeout: true,
      },
    };
  }

  try {
    const response = await fetchWithDeadline(
      sourceUrl,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      },
      {
        deadlineMs,
        timeoutMs: SNAPSHOT_FETCH_TIMEOUT_MS,
      }
    );
    if (!response.ok) {
      return {
        error: {
          status: response.status,
          statusText: response.statusText,
          url: sourceUrl,
          variant,
        },
      };
    }
    const html = await response.text();
    const extraction = extractFromHtmlCandidate({
      html,
      sourceUrl,
      variant,
      targetUrl,
      timestamp,
    });
    if (!extraction) {
      return {
        error: {
          message: "Could not extract readable content from snapshot HTML.",
          url: sourceUrl,
          variant,
        },
      };
    }
    return { extraction };
  } catch (error) {
    return {
      error: {
        message: error.message,
        url: sourceUrl,
        variant,
        timeout: error?.code === "FETCH_TIMEOUT" || error?.code === "DEADLINE_EXCEEDED",
      },
    };
  }
}

async function resolveBestExtractionForSnapshot({
  archiveUrl,
  targetUrl,
  timestamp,
  deadlineMs,
}) {
  const variants = buildSnapshotVariantCandidates(archiveUrl, targetUrl, timestamp);
  let bestExtraction = null;
  let lastError = null;

  for (let index = 0; index < variants.length; index += 1) {
    if (index > 0 && !shouldTryAlternateVariant(bestExtraction)) {
      break;
    }
    if (isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_SNAPSHOT_MS)) {
      break;
    }

    const candidate = variants[index];
    const { extraction, error } = await fetchAndExtractVariant({
      targetUrl,
      timestamp,
      variant: candidate.variant,
      sourceUrl: candidate.url,
      deadlineMs,
    });
    if (error) {
      lastError = error;
      if (error.timeout && bestExtraction) {
        break;
      }
      continue;
    }
    bestExtraction = chooseBestExtraction([bestExtraction, extraction].filter(Boolean));
  }

  if (!bestExtraction) {
    if (!lastError && isDeadlineExceeded(deadlineMs, DEADLINE_RESERVE_MS)) {
      return {
        error: {
          message: "Extraction timed out before any snapshot variant completed.",
          timeout: true,
        },
      };
    }
    return { error: lastError };
  }
  return { extraction: bestExtraction };
}

async function lookupCdxSnapshots(targetUrl, limit = 5, deadlineMs) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 8));
  const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
    targetUrl
  )}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&limit=${safeLimit}&sort=descending`;

  try {
    const response = await fetchWithDeadline(
      cdxUrl,
      {
        headers: { "User-Agent": USER_AGENT },
      },
      {
        deadlineMs,
        timeoutMs: API_FETCH_TIMEOUT_MS,
      }
    );
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) {
      return [];
    }
    const snapshots = [];
    const seen = new Set();
    data.slice(1).forEach((row) => {
      const timestamp = row?.[0];
      const original = row?.[1] || targetUrl;
      if (!timestamp) return;
      const key = `${timestamp}|${original}`;
      if (seen.has(key)) return;
      seen.add(key);
      snapshots.push({
        url: buildArchiveUrl(original, timestamp, null),
        timestamp,
        original,
      });
    });
    return snapshots;
  } catch (error) {
    return [];
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

function extractFromHtmlCandidate({ html, sourceUrl, variant, targetUrl, timestamp }) {
  const baseUrl = sourceUrl || targetUrl;
  const dom = createDom(html, { url: baseUrl });
  const document = dom.window.document;

  const sourceArticleLength = pickLikelySourceArticleLength(document);
  const sourceBodyLength = textLengthFromDocumentBody(document);

  stripInlineHandlers(document);
  const figureCaptionIndex = buildFigureCaptionIndex(document, baseUrl);
  const heroImageSource =
    extractHeroImageSource(document, baseUrl) || figureCaptionIndex.firstFigureImageUrl;
  const heroImage = heroImageSource ? buildArchiveUrl(heroImageSource, timestamp, "im") : null;
  const heroCaption = extractFeaturedImageCaption(baseUrl, heroImageSource, figureCaptionIndex);
  const publicationName = extractSiteName(document) || fallbackSiteNameFromUrl(targetUrl);
  const publishedDate = extractPublishedDate(document);
  const jsonLdBodyHtml = extractJsonLdArticleBodyHtml(document);

  // Readability mutates the passed document; keep the original for fallback extraction.
  const readabilityDocument = document.cloneNode(true);
  const reader = new Readability(readabilityDocument);
  const article = reader.parse();
  if (!article?.content) {
    return null;
  }

  let cleaned = cleanContent(article.content, baseUrl, timestamp);
  cleaned = enrichContentWithFigureCaptions(cleaned, baseUrl, figureCaptionIndex);
  cleaned = prependHeroImage(cleaned, heroImage, heroCaption);

  let extractedTextLength = textLengthFromHtml(cleaned);
  const shouldTryFallback =
    extractedTextLength < 4500 ||
    (sourceArticleLength > 0 && extractedTextLength < sourceArticleLength * 0.75);

  if (shouldTryFallback) {
    const fallbackHtml = buildFallbackContentHtml(document, baseUrl, timestamp);
    if (fallbackHtml) {
      let enrichedFallback = enrichContentWithFigureCaptions(
        fallbackHtml,
        baseUrl,
        figureCaptionIndex
      );
      enrichedFallback = prependHeroImage(enrichedFallback, heroImage, heroCaption);
      const fallbackLength = textLengthFromHtml(enrichedFallback);
      const fallbackIsStronger =
        fallbackLength >= 1200 &&
        fallbackLength > extractedTextLength * 1.2 &&
        fallbackLength - extractedTextLength >= 800;
      if (fallbackIsStronger) {
        cleaned = enrichedFallback;
        extractedTextLength = fallbackLength;
      }
    }
  }

  if (jsonLdBodyHtml) {
    const jsonLdLength = textLengthFromHtml(jsonLdBodyHtml);
    const jsonLdIsStronger =
      jsonLdLength >= 1200 &&
      jsonLdLength > extractedTextLength * 1.3 &&
      jsonLdLength - extractedTextLength >= 900;
    if (jsonLdIsStronger) {
      cleaned = prependHeroImage(jsonLdBodyHtml, heroImage, heroCaption);
      extractedTextLength = textLengthFromHtml(cleaned);
    }
  }

  const sourceTextLength = resolveSourceLength(sourceArticleLength, sourceBodyLength);
  const coverage = sourceTextLength > 0 ? extractedTextLength / sourceTextLength : 0;
  const extractionWarning = buildExtractionWarning({
    extractedTextLength,
    sourceArticleLength,
    sourceBodyLength,
  });

  return {
    title: article.title,
    byline: article.byline,
    excerpt: article.excerpt,
    contentHtml: cleaned,
    heroImage,
    publicationName,
    publishedDate,
    extractionWarning,
    extractionSource: variant,
    _quality: {
      hasWarning: Boolean(extractionWarning),
      extractedTextLength,
      coverage,
      sourceTextLength,
    },
  };
}

function compareExtractionQuality(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;

  const leftLength = left._quality?.extractedTextLength || 0;
  const rightLength = right._quality?.extractedTextLength || 0;
  const maxLength = Math.max(leftLength, rightLength);
  const minLength = Math.min(leftLength, rightLength);
  const lengthRatio = minLength > 0 ? maxLength / minLength : maxLength > 0 ? Infinity : 1;
  const lengthDelta = Math.abs(rightLength - leftLength);
  // If one extraction is substantially longer, prefer it even if warning heuristics differ.
  if (lengthRatio >= 1.25 && lengthDelta >= 1200) {
    return rightLength - leftLength;
  }

  const leftWarning = left._quality?.hasWarning ? 1 : 0;
  const rightWarning = right._quality?.hasWarning ? 1 : 0;
  if (leftWarning !== rightWarning) return leftWarning - rightWarning;
  if (leftLength !== rightLength) return rightLength - leftLength;

  const leftCoverage = left._quality?.coverage || 0;
  const rightCoverage = right._quality?.coverage || 0;
  if (leftCoverage !== rightCoverage) {
    return rightCoverage - leftCoverage;
  }

  return 0;
}

function chooseBestExtraction(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return results.reduce((best, candidate) => {
    if (!best) return candidate;
    return compareExtractionQuality(candidate, best) < 0 ? candidate : best;
  }, null);
}

function timestampToNumber(value) {
  if (!value) return 0;
  const digits = String(value).match(/\d{14}/);
  if (!digits) return 0;
  return Number(digits[0]) || 0;
}

function chooseBestResolvedPage(left, right) {
  if (!left) return right;
  if (!right) return left;
  const qualityOrder = compareExtractionQuality(right.extraction, left.extraction);
  if (qualityOrder < 0) return right;
  if (qualityOrder > 0) return left;
  return timestampToNumber(right.archiveTimestamp) > timestampToNumber(left.archiveTimestamp)
    ? right
    : left;
}

function snapshotKey(snapshotEntry, targetUrl) {
  if (!snapshotEntry) return "";
  const timestamp = extractTimestamp(snapshotEntry.url || "", snapshotEntry.timestamp || "");
  const original = snapshotEntry.original || targetUrl || "";
  return `${timestamp}|${original}`;
}

function shouldTryAdditionalSnapshots(resolvedPage) {
  if (!resolvedPage?.extraction?._quality) return true;
  const quality = resolvedPage.extraction._quality;
  const sourceLength = quality.sourceTextLength || 0;
  const extractedLength = quality.extractedTextLength || 0;
  const coverage = quality.coverage || 0;
  const missingChars = sourceLength - extractedLength;

  if (sourceLength <= 0) {
    return extractedLength < 5200;
  }

  if (coverage >= 0.72) return false;
  if (extractedLength >= 7000 && coverage >= 0.65) return false;
  if (missingChars <= 1800) return false;
  if (quality.hasWarning && coverage < 0.65 && missingChars > 2200) return true;
  if (coverage < 0.55) return true;
  return sourceLength >= 9000 && coverage < 0.66;
}

async function resolveSnapshotCandidate(snapshotEntry, archiveSource, targetUrl, deadlineMs) {
  const archiveUrl = snapshotEntry.url;
  const timestamp = extractTimestamp(archiveUrl, snapshotEntry.timestamp);
  const { extraction, error } = await resolveBestExtractionForSnapshot({
    archiveUrl,
    targetUrl,
    timestamp,
    deadlineMs,
  });
  if (!extraction) {
    return { error };
  }
  return {
    extraction,
    archiveUrl,
    archiveTimestamp: timestamp,
    archiveSource,
  };
}

function isLikelyIpHost(hostname) {
  if (!hostname) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(":")) return true;
  return false;
}

function canToggleWww(hostname) {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (isLikelyIpHost(hostname)) return false;
  return hostname.includes(".");
}

function toggleWwwForUrl(url) {
  try {
    const parsed = new URL(url);
    if (!canToggleWww(parsed.hostname)) return null;
    parsed.hostname = parsed.hostname.startsWith("www.")
      ? parsed.hostname.slice(4)
      : `www.${parsed.hostname}`;
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function toggleTrailingSlashForUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/") return null;
    parsed.pathname = parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1) || "/"
      : `${parsed.pathname}/`;
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function buildTargetUrlVariants(targetUrl) {
  const candidates = [
    targetUrl,
    toggleTrailingSlashForUrl(targetUrl),
    toggleWwwForUrl(targetUrl),
  ];
  const slashThenWww = candidates[1] ? toggleWwwForUrl(candidates[1]) : null;
  const wwwThenSlash = candidates[2] ? toggleTrailingSlashForUrl(candidates[2]) : null;
  candidates.push(slashThenWww, wwwThenSlash);

  const variants = [];
  const seen = new Set();
  candidates.forEach((candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    variants.push(candidate);
  });
  return variants;
}

function scoreFallbackResult(statusCode, payload, variantIndex) {
  const status = payload?.status;
  let score = 100;
  if (statusCode === 200 && status === "archived_link_only") {
    score = 510;
  } else if (statusCode === 200 && status === "submitted") {
    score = 500;
  } else if (statusCode === 200 && status === "blocked") {
    score = 450;
  } else if (statusCode === 200 && status) {
    score = 400;
  } else if (statusCode === 502) {
    score = 300;
  } else if (statusCode === 500) {
    score = 250;
  } else if (statusCode >= 400 && statusCode < 500) {
    score = 200;
  }
  return score - variantIndex;
}

function decorateVariantResponse(result, requestedUrl, resolvedUrl) {
  const payload = { ...(result.payload || {}) };
  if (result.statusCode === 200) {
    payload.originalUrl = requestedUrl;
    if (resolvedUrl && resolvedUrl !== requestedUrl) {
      payload.resolvedUrl = resolvedUrl;
    }
  }
  return {
    statusCode: result.statusCode,
    payload,
  };
}

async function resolveArchiveForTarget(
  targetUrl,
  { allowSaveSubmission = true, deadlineMs } = {}
) {
  if (isDeadlineExceeded(deadlineMs, DEADLINE_RESERVE_MS)) {
    return {
      statusCode: 502,
      payload: { error: "Archive lookup timed out before request could complete." },
    };
  }

  const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;

  let availability;
  try {
    const availabilityRes = await fetchWithDeadline(
      availabilityUrl,
      {
        headers: { "User-Agent": USER_AGENT },
      },
      {
        deadlineMs,
        timeoutMs: API_FETCH_TIMEOUT_MS,
      }
    );
    if (!availabilityRes.ok) {
      return {
        statusCode: 502,
        payload: { error: "Wayback availability check failed." },
      };
    }
    availability = await availabilityRes.json();
  } catch (error) {
    return {
      statusCode: 502,
      payload: {
        error:
          error?.code === "FETCH_TIMEOUT" || error?.code === "DEADLINE_EXCEEDED"
            ? "Wayback availability check timed out."
            : "Wayback availability check failed.",
      },
    };
  }

  const closest = availability?.archived_snapshots?.closest;
  let cdxSnapshots = null;

  let primarySnapshot = null;
  let primarySource = null;
  if (closest?.url) {
    primarySnapshot = {
      url: closest.url,
      timestamp: closest.timestamp,
      original: closest.original || targetUrl,
    };
    primarySource = "availability";
  } else {
    cdxSnapshots = await lookupCdxSnapshots(targetUrl, 5, deadlineMs);
    if (cdxSnapshots.length > 0) {
      primarySnapshot = cdxSnapshots[0];
      primarySource = "cdx";
    }
  }

  if (!primarySnapshot) {
    if (!allowSaveSubmission) {
      return {
        statusCode: 404,
        payload: { error: "No archived snapshot found for this URL variant." },
      };
    }
    if (isDeadlineExceeded(deadlineMs, API_FETCH_TIMEOUT_MS)) {
      return {
        statusCode: 502,
        payload: { error: "Wayback lookup timed out before save submission." },
      };
    }

    let archiveUrl = null;
    let submission = null;
    try {
      const saveRes = await fetchWithDeadline(
        `https://web.archive.org/save/${targetUrl}`,
        {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": USER_AGENT },
        },
        {
          deadlineMs,
          timeoutMs: API_FETCH_TIMEOUT_MS,
        }
      );
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
      return {
        statusCode: 200,
        payload: {
          status: "blocked",
          originalUrl: targetUrl,
          archiveUrl,
          submission,
          message: "Wayback could not archive this URL.",
        },
      };
    }

    return {
      statusCode: 200,
      payload: {
        status: "submitted",
        originalUrl: targetUrl,
        archiveUrl,
        message: "This URL was not archived yet. A request to archive it has been submitted.",
      },
    };
  }

  const processedSnapshots = new Set();
  const MAX_SNAPSHOT_ATTEMPTS = 2;
  let resolvedPage = null;
  let lastFetchError = null;

  const attemptSnapshot = async (snapshotEntry, source) => {
    if (!snapshotEntry?.url) return;
    if (isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_SNAPSHOT_MS)) return;
    const key = snapshotKey(snapshotEntry, targetUrl);
    if (!key || processedSnapshots.has(key)) return;
    if (processedSnapshots.size >= MAX_SNAPSHOT_ATTEMPTS) return;
    processedSnapshots.add(key);

    const candidate = await resolveSnapshotCandidate(
      snapshotEntry,
      source,
      targetUrl,
      deadlineMs
    );
    if (candidate?.extraction) {
      resolvedPage = chooseBestResolvedPage(resolvedPage, candidate);
    } else if (candidate?.error) {
      lastFetchError = candidate.error;
    }
  };

  await attemptSnapshot(primarySnapshot, primarySource);

  if (
    (!resolvedPage || shouldTryAdditionalSnapshots(resolvedPage)) &&
    processedSnapshots.size < MAX_SNAPSHOT_ATTEMPTS &&
    !isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_SNAPSHOT_MS)
  ) {
    if (!cdxSnapshots) {
      cdxSnapshots = await lookupCdxSnapshots(targetUrl, 5, deadlineMs);
    }
    for (const snapshotEntry of cdxSnapshots) {
      if (processedSnapshots.size >= MAX_SNAPSHOT_ATTEMPTS) {
        break;
      }
      if (isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_SNAPSHOT_MS)) {
        break;
      }
      await attemptSnapshot(snapshotEntry, "cdx");
      if (resolvedPage && !shouldTryAdditionalSnapshots(resolvedPage)) {
        break;
      }
    }
  }

  if (!resolvedPage) {
    const fallbackArchiveUrl = primarySnapshot?.url || null;
    if (fallbackArchiveUrl) {
      const fallbackTimestamp = extractTimestamp(
        fallbackArchiveUrl,
        primarySnapshot?.timestamp
      );
      return {
        statusCode: 200,
        payload: {
          status: "archived_link_only",
          originalUrl: targetUrl,
          archiveUrl: fallbackArchiveUrl,
          archiveSource: primarySource,
          archiveTimestamp: fallbackTimestamp,
          title: "Archived snapshot",
          message:
            "Archive snapshot found, but clean reader extraction is unavailable right now.",
          details: lastFetchError,
        },
      };
    }
    if (lastFetchError) {
      return {
        statusCode: 502,
        payload: {
          error: "Failed to fetch the archived page.",
          details: lastFetchError,
        },
      };
    }
    return {
      statusCode: 500,
      payload: { error: "Could not extract readable content from archived snapshots." },
    };
  }

  const best = resolvedPage.extraction;
  return {
    statusCode: 200,
    payload: {
      status: "archived",
      originalUrl: targetUrl,
      archiveUrl: resolvedPage.archiveUrl,
      title: best.title,
      byline: best.byline,
      excerpt: best.excerpt,
      contentHtml: best.contentHtml,
      archiveSource: resolvedPage.archiveSource,
      archiveTimestamp: resolvedPage.archiveTimestamp,
      heroImage: best.heroImage,
      publicationName: best.publicationName,
      publishedDate: best.publishedDate,
      extractionWarning: best.extractionWarning,
      extractionSource: best.extractionSource,
    },
  };
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
  const requestedUrl = parsed.href;

  const variants = buildTargetUrlVariants(requestedUrl);
  const deadlineMs = Date.now() + HANDLER_DEADLINE_MS;
  let bestFallback = null;

  for (let index = 0; index < variants.length; index += 1) {
    if (index > 0 && isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_SNAPSHOT_MS)) {
      break;
    }
    const variantUrl = variants[index];
    const attempt = await resolveArchiveForTarget(variantUrl, {
      allowSaveSubmission: index === 0,
      deadlineMs,
    });
    const decorated = decorateVariantResponse(attempt, requestedUrl, variantUrl);
    if (decorated.statusCode === 200 && decorated.payload?.status === "archived") {
      return json(200, decorated.payload);
    }

    const score = scoreFallbackResult(decorated.statusCode, decorated.payload, index);
    if (!bestFallback || score > bestFallback.score) {
      bestFallback = { score, result: decorated };
    }
  }

  if (!bestFallback) {
    return json(502, { error: "Wayback availability check failed." });
  }
  return json(bestFallback.result.statusCode, bestFallback.result.payload);
};
