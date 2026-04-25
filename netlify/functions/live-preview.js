const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const USER_AGENT = "WebArchiveLivePreview/1.0";
const PARSE_HTML_MAX_LENGTH = 3_000_000;
const MIN_HERO_TEXT_LENGTH = 900;
const HANDLER_DEADLINE_MS = 20_000;
const FETCH_TIMEOUT_MS = 9_000;
const DEADLINE_RESERVE_MS = 250;
const MIN_TIME_FOR_EXTRA_VARIANT_MS = 3_000;
const MAX_VARIANT_ATTEMPTS = 4;
const TRACKING_QUERY_PREFIXES = ["utm_", "mc_", "pk_", "vero_", "ga_", "hsa_"];
const TRACKING_QUERY_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "gbraid",
  "wbraid",
  "igshid",
  "mkt_tok",
  "_hsenc",
  "_hsmi",
  "ref_src",
  "soc_src",
  "soc_trk",
  "si",
]);
const CONTENT_QUERY_NAMES = new Set([
  "id",
  "p",
  "page",
  "article",
  "story",
  "slug",
  "lang",
  "locale",
  "q",
  "query",
  "search",
  "s",
  "category",
  "cat",
  "tag",
  "tags",
]);

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
  { deadlineMs, timeoutMs = FETCH_TIMEOUT_MS, reserveMs = DEADLINE_RESERVE_MS } = {}
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

function sanitizeAbsoluteUrl(value, baseUrl, { allowContactLinks = false } = {}) {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
    if (allowContactLinks && (parsed.protocol === "mailto:" || parsed.protocol === "tel:")) {
      return parsed.toString();
    }
    return "";
  } catch (error) {
    return "";
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

function resolveSourceLength(sourceArticleLength, sourceBodyLength) {
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
      "This preview may be incomplete. Compare with the original page for the full content.",
    coverage: Number(coverage.toFixed(3)),
    extractedTextLength,
    sourceTextLength: sourceLength,
  };
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
      // Ignore invalid JSON-LD blocks.
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
    const candidate = toDateOnly(node.getAttribute(attr));
    if (candidate) return candidate;
  }

  const timeNode =
    document.querySelector("time[datetime]") ||
    document.querySelector('time[itemprop="datePublished"]') ||
    document.querySelector("time[pubdate]");
  if (timeNode) {
    const candidate = toDateOnly(timeNode.getAttribute("datetime") || timeNode.textContent);
    if (candidate) return candidate;
  }

  const itemProp = document.querySelector('[itemprop="datePublished"]');
  if (itemProp) {
    const candidate = toDateOnly(itemProp.getAttribute("content") || itemProp.textContent);
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
      // Ignore invalid JSON-LD.
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
    if (cleaned) return cleaned;
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

function rewriteSrcsetAbsolute(value, baseUrl) {
  return String(value || "")
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const pieces = trimmed.split(/\s+/);
      const rawUrl = pieces.shift();
      const absolute = sanitizeAbsoluteUrl(rawUrl, baseUrl);
      if (!absolute) return "";
      return [absolute, ...pieces].join(" ");
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

function cleanContent(html, baseUrl) {
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

  // Remove inline styles so extracted content cannot force overlays or full-screen media.
  document.querySelectorAll("[style]").forEach((node) => {
    node.removeAttribute("style");
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
    { selector: "img", attr: "src" },
    { selector: "img", attr: "srcset", isSrcset: true },
    { selector: "source", attr: "src" },
    { selector: "source", attr: "srcset", isSrcset: true },
    { selector: "a", attr: "href", allowContactLinks: true },
    { selector: "video", attr: "src" },
    { selector: "audio", attr: "src" },
    { selector: "track", attr: "src" },
  ];

  urlAttributes.forEach(({ selector, attr, isSrcset, allowContactLinks }) => {
    document.querySelectorAll(selector).forEach((node) => {
      const value = node.getAttribute(attr);
      if (!value) return;
      if (isSrcset) {
        node.setAttribute(attr, rewriteSrcsetAbsolute(value, baseUrl));
        return;
      }
      const safeUrl = sanitizeAbsoluteUrl(value, baseUrl, { allowContactLinks });
      if (safeUrl) {
        node.setAttribute(attr, safeUrl);
      } else {
        node.removeAttribute(attr);
      }
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

function buildFallbackContentHtml(document, baseUrl) {
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

  return cleanContent(clone.innerHTML || "", baseUrl);
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
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    let path = parsed.pathname || "";
    if (path !== "/") {
      path = path.replace(/\/+$/, "");
    }
    return `${parsed.origin}${path}`.toLowerCase();
  } catch (error) {
    return String(value || "").toLowerCase();
  }
}

function getUrlBasename(value) {
  try {
    const parsed = new URL(value);
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
        if (!isValidHttpUrl(absolute)) return;
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
  if (contentHtml.includes(heroUrl)) {
    return contentHtml;
  }
  const captionMarkup = heroCaption
    ? `<figcaption>${escapeHtml(heroCaption)}</figcaption>`
    : "";
  return `<figure class="reader-hero"><img src="${heroUrl}" alt="" />${captionMarkup}</figure>${contentHtml}`;
}

function maybePrependHeroImage(contentHtml, heroUrl, heroCaption, extractedTextLength) {
  const textLength =
    typeof extractedTextLength === "number"
      ? extractedTextLength
      : textLengthFromHtml(contentHtml);
  if (textLength < MIN_HERO_TEXT_LENGTH) {
    return contentHtml;
  }
  return prependHeroImage(contentHtml, heroUrl, heroCaption);
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

function extractFromHtmlCandidate({ html, sourceUrl, targetUrl }) {
  const baseUrl = sourceUrl || targetUrl;
  const dom = createDom(html, { url: baseUrl });
  const document = dom.window.document;

  const sourceArticleLength = pickLikelySourceArticleLength(document);
  const sourceBodyLength = textLengthFromDocumentBody(document);

  stripInlineHandlers(document);
  const figureCaptionIndex = buildFigureCaptionIndex(document, baseUrl);
  const heroImageSource =
    extractHeroImageSource(document, baseUrl) || figureCaptionIndex.firstFigureImageUrl;
  const heroImage = heroImageSource || null;
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

  let cleaned = cleanContent(article.content, baseUrl);
  cleaned = enrichContentWithFigureCaptions(cleaned, baseUrl, figureCaptionIndex);
  let extractedTextLength = textLengthFromHtml(cleaned);
  cleaned = maybePrependHeroImage(cleaned, heroImage, heroCaption, extractedTextLength);
  const shouldTryFallback =
    extractedTextLength < 4500 ||
    (sourceArticleLength > 0 && extractedTextLength < sourceArticleLength * 0.75);

  if (shouldTryFallback) {
    const fallbackHtml = buildFallbackContentHtml(document, baseUrl);
    if (fallbackHtml) {
      let enrichedFallback = enrichContentWithFigureCaptions(
        fallbackHtml,
        baseUrl,
        figureCaptionIndex
      );
      const fallbackLength = textLengthFromHtml(enrichedFallback);
      enrichedFallback = maybePrependHeroImage(
        enrichedFallback,
        heroImage,
        heroCaption,
        fallbackLength
      );
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
      cleaned = maybePrependHeroImage(
        jsonLdBodyHtml,
        heroImage,
        heroCaption,
        jsonLdLength
      );
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

function chooseBestResolvedPage(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareExtractionQuality(right.extraction, left.extraction) < 0 ? right : left;
}

function shouldTryAdditionalVariants(resolvedPage) {
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

function dedupeUrls(candidates) {
  const variants = [];
  const seen = new Set();
  candidates.forEach((candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    variants.push(candidate);
  });
  return variants;
}

function classifyQueryParamName(name) {
  const key = String(name || "").toLowerCase();
  if (!key) return "unknown";
  if (TRACKING_QUERY_NAMES.has(key)) return "tracking";
  if (TRACKING_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix))) return "tracking";
  if (CONTENT_QUERY_NAMES.has(key)) return "content";
  return "unknown";
}

function buildFilteredQueryUrl(sourceUrl, mode) {
  try {
    const parsed = new URL(sourceUrl);
    if (!parsed.searchParams.size) return null;
    const keptEntries = [];
    let changed = false;

    for (const [name, value] of parsed.searchParams.entries()) {
      const category = classifyQueryParamName(name);
      const keep =
        mode === "drop_tracking" ? category !== "tracking" : category === "content";
      if (keep) {
        keptEntries.push([name, value]);
      } else {
        changed = true;
      }
    }

    if (!changed) return null;

    const next = new URL(parsed.toString());
    next.search = "";
    keptEntries.forEach(([name, value]) => next.searchParams.append(name, value));
    const resolved = next.toString();
    if (resolved === sourceUrl) return null;
    return resolved;
  } catch (error) {
    return null;
  }
}

function buildQueryNormalizedVariants(sourceUrl) {
  const trackingCleaned = buildFilteredQueryUrl(sourceUrl, "drop_tracking");
  const contentOnly = buildFilteredQueryUrl(sourceUrl, "keep_content");
  return dedupeUrls([trackingCleaned, contentOnly]);
}

function buildHostPathVariants(targetUrl) {
  const candidates = [
    targetUrl,
    toggleTrailingSlashForUrl(targetUrl),
    toggleWwwForUrl(targetUrl),
  ];
  const slashThenWww = candidates[1] ? toggleWwwForUrl(candidates[1]) : null;
  const wwwThenSlash = candidates[2] ? toggleTrailingSlashForUrl(candidates[2]) : null;
  candidates.push(slashThenWww, wwwThenSlash);
  return dedupeUrls(candidates);
}

function buildTargetUrlVariants(targetUrl) {
  const hostVariants = buildHostPathVariants(targetUrl);
  const queryVariants = buildQueryNormalizedVariants(targetUrl);
  return dedupeUrls([
    hostVariants[0],
    ...queryVariants,
    ...hostVariants.slice(1),
  ]);
}

function summarizeQueryNormalization(requestedUrl, resolvedUrl) {
  try {
    const requested = new URL(requestedUrl);
    const resolved = new URL(resolvedUrl);
    if (requested.search === resolved.search) return null;

    const resolvedCounts = new Map();
    for (const name of resolved.searchParams.keys()) {
      const key = name.toLowerCase();
      resolvedCounts.set(key, (resolvedCounts.get(key) || 0) + 1);
    }

    const removedTracking = new Set();
    const removedUnknown = new Set();
    const removedContent = new Set();

    for (const name of requested.searchParams.keys()) {
      const key = name.toLowerCase();
      const count = resolvedCounts.get(key) || 0;
      if (count > 0) {
        resolvedCounts.set(key, count - 1);
        continue;
      }
      const category = classifyQueryParamName(name);
      if (category === "tracking") {
        removedTracking.add(key);
      } else if (category === "content") {
        removedContent.add(key);
      } else {
        removedUnknown.add(key);
      }
    }

    if (!removedTracking.size && !removedUnknown.size && !removedContent.size) {
      return null;
    }

    return {
      removedTrackingParams: Array.from(removedTracking),
      removedUnknownParams: Array.from(removedUnknown),
      removedContentParams: Array.from(removedContent),
    };
  } catch (error) {
    return null;
  }
}

function isHtmlLikeContentType(contentType) {
  const normalized = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}

async function fetchAndExtractVariant({ targetUrl, sourceUrl, deadlineMs }) {
  if (isDeadlineExceeded(deadlineMs, DEADLINE_RESERVE_MS)) {
    return {
      error: {
        message: "Preview deadline exceeded before the page could be fetched.",
        url: sourceUrl,
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
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      {
        deadlineMs,
        timeoutMs: FETCH_TIMEOUT_MS,
      }
    );
    if (!response.ok) {
      return {
        error: {
          message: `The source page responded with ${response.status}.`,
          status: response.status,
          url: sourceUrl,
        },
      };
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!isHtmlLikeContentType(contentType)) {
      return {
        error: {
          message: "The source URL did not return an HTML page.",
          url: sourceUrl,
        },
      };
    }

    const html = await response.text();
    const responseUrl = response.url || sourceUrl;
    const extraction = extractFromHtmlCandidate({
      html,
      sourceUrl: responseUrl,
      targetUrl,
    });
    if (!extraction) {
      return {
        error: {
          message: "Could not extract a readable preview from the source page.",
          url: responseUrl,
        },
      };
    }

    return { extraction, responseUrl };
  } catch (error) {
    return {
      error: {
        message:
          error?.code === "FETCH_TIMEOUT" || error?.code === "DEADLINE_EXCEEDED"
            ? "Fetching the source page timed out."
            : "Failed to fetch the source page.",
        url: sourceUrl,
        timeout: error?.code === "FETCH_TIMEOUT" || error?.code === "DEADLINE_EXCEEDED",
      },
    };
  }
}

async function resolveLivePreview(requestedUrl, deadlineMs) {
  const variants = buildTargetUrlVariants(requestedUrl);
  let bestPage = null;
  let lastError = null;

  for (let index = 0; index < variants.length && index < MAX_VARIANT_ATTEMPTS; index += 1) {
    if (index > 0 && !shouldTryAdditionalVariants(bestPage)) {
      break;
    }
    if (index > 0 && isDeadlineExceeded(deadlineMs, MIN_TIME_FOR_EXTRA_VARIANT_MS)) {
      break;
    }

    const variantUrl = variants[index];
    const { extraction, responseUrl, error } = await fetchAndExtractVariant({
      targetUrl: requestedUrl,
      sourceUrl: variantUrl,
      deadlineMs,
    });

    if (!extraction) {
      lastError = error;
      continue;
    }

    bestPage = chooseBestResolvedPage(bestPage, {
      extraction,
      resolvedUrl: responseUrl || variantUrl,
    });
  }

  if (!bestPage) {
    return {
      statusCode: 502,
      payload: {
        error: lastError?.message || "Could not generate a live preview for this URL.",
        details: lastError || null,
      },
    };
  }

  const best = bestPage.extraction;
  const pageUrl = bestPage.resolvedUrl || requestedUrl;
  return {
    statusCode: 200,
    payload: {
      status: "previewed",
      originalUrl: requestedUrl,
      resolvedUrl: pageUrl !== requestedUrl ? pageUrl : null,
      pageUrl,
      queryNormalization: summarizeQueryNormalization(requestedUrl, pageUrl),
      title: best.title,
      byline: best.byline,
      excerpt: best.excerpt,
      contentHtml: best.contentHtml,
      heroImage: best.heroImage,
      publicationName: best.publicationName,
      publishedDate: best.publishedDate,
      extractionWarning: best.extractionWarning,
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

  const deadlineMs = Date.now() + HANDLER_DEADLINE_MS;
  const result = await resolveLivePreview(requestedUrl, deadlineMs);
  return json(result.statusCode, result.payload);
};
