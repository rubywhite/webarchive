const titleEl = document.getElementById("reader-title");
const bylineEl = document.getElementById("reader-byline");
const archiveLink = document.getElementById("archive-link");
const archiveSource = document.getElementById("archive-source");
const originalUrl = document.getElementById("original-url");
const contentEl = document.getElementById("reader-content");
const statusEl = document.getElementById("reader-status");
const shareButton = document.getElementById("share-button");
const readerWarning = document.getElementById("reader-warning");
const shareQr = document.getElementById("share-qr");
const shareQrImage = document.getElementById("share-qr-image");
const shareQrLink = document.getElementById("share-qr-link");

const CACHE_PREFIX = "webArchiveCache:";
const CACHE_VERSION = "v2";

const setStatus = (message, type = "info") => {
  statusEl.textContent = message || "";
  statusEl.dataset.type = type;
};

const buildCacheKey = (payload) => {
  const seed = `${CACHE_VERSION}|${payload.archiveTimestamp || ""}|${payload.originalUrl || ""}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return `wa-${(hash >>> 0).toString(36)}`;
};

const normalizeShareText = (value, maxLength) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
};

const formatPublishedDate = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(utcDate);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(parsed);
};

const buildTitleMeta = ({ byline, excerpt, publishedDate }) => {
  const parts = [];
  const primary = String(byline || excerpt || "").trim();
  const formattedDate = formatPublishedDate(publishedDate);
  if (primary) parts.push(primary);
  if (formattedDate) parts.push(`Published ${formattedDate}`);
  return parts.join(" • ");
};

const setReaderWarning = (warning) => {
  if (!readerWarning) return;
  const message = String(warning?.message || "").trim();
  if (!message) {
    readerWarning.textContent = "";
    readerWarning.classList.add("hidden");
    return;
  }
  readerWarning.textContent = message;
  readerWarning.classList.remove("hidden");
};

const buildShareUrl = ({ originalUrl: pageUrl, cacheKey, title }) => {
  const target = new URL(cacheKey ? `/s/${encodeURIComponent(cacheKey)}` : "/s", window.location.origin);
  if (pageUrl) target.searchParams.set("url", pageUrl);
  const cleanTitle = normalizeShareText(title, 180);
  if (cleanTitle) target.searchParams.set("title", cleanTitle);
  return target.toString();
};

const buildCompactShareUrl = (shareUrl) => {
  try {
    const parsed = new URL(shareUrl);
    const compact = new URL(parsed.pathname, parsed.origin);
    const targetUrl = parsed.searchParams.get("url");
    const targetTitle = parsed.searchParams.get("title");
    const cache = parsed.searchParams.get("cache");
    if (targetUrl) {
      compact.searchParams.set("url", targetUrl);
    }
    if (targetTitle) {
      compact.searchParams.set("title", targetTitle);
    }
    if (!compact.pathname.startsWith("/s/") && cache) {
      compact.searchParams.set("cache", cache);
    }
    return compact.toString();
  } catch (error) {
    return String(shareUrl || "").trim();
  }
};

const upsertMeta = (selector, attrName, attrValue, content) => {
  if (!content) return;
  let node = document.head.querySelector(selector);
  if (!node) {
    node = document.createElement("meta");
    node.setAttribute(attrName, attrValue);
    document.head.appendChild(node);
  }
  node.setAttribute("content", content);
};

const upsertCanonical = (href) => {
  if (!href) return;
  let node = document.head.querySelector('link[rel="canonical"]');
  if (!node) {
    node = document.createElement("link");
    node.setAttribute("rel", "canonical");
    document.head.appendChild(node);
  }
  node.setAttribute("href", href);
};

const updateShareMeta = (payload, shareUrl) => {
  const safeTitle = normalizeShareText(payload?.title, 180) || "Web Archive Reader";
  const safeDescription =
    normalizeShareText(payload?.excerpt || payload?.byline, 280) ||
    "Reader view for archived pages from the Wayback Machine.";
  const safeImage = String(payload?.heroImage || "").trim();
  const safeShareUrl = String(shareUrl || "").trim();

  upsertMeta('meta[name="description"]', "name", "description", safeDescription);
  upsertMeta('meta[property="og:title"]', "property", "og:title", safeTitle);
  upsertMeta('meta[property="og:description"]', "property", "og:description", safeDescription);
  if (safeImage) {
    upsertMeta('meta[property="og:image"]', "property", "og:image", safeImage);
    upsertMeta('meta[name="twitter:image"]', "name", "twitter:image", safeImage);
  }
  if (safeShareUrl) {
    upsertMeta('meta[property="og:url"]', "property", "og:url", safeShareUrl);
    upsertCanonical(safeShareUrl);
  }
  upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", safeTitle);
  upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", safeDescription);
};

const syncAddressWithShareUrl = (shareUrl) => {
  const compactUrl = buildCompactShareUrl(shareUrl);
  if (!compactUrl || compactUrl === "#") return compactUrl;
  if (window.location.href !== compactUrl) {
    window.history.replaceState(null, "", compactUrl);
  }
  return compactUrl;
};

const buildQrImageUrl = (value) => {
  const target = new URL("https://api.qrserver.com/v1/create-qr-code/");
  target.searchParams.set("size", "320x320");
  target.searchParams.set("margin", "0");
  target.searchParams.set("ecc", "L");
  target.searchParams.set("data", value);
  return target.toString();
};

const updateShareQr = (shareUrl) => {
  if (!shareQr || !shareQrImage || !shareQrLink) return;
  const rawValue = String(shareUrl || "").trim();
  if (!rawValue || rawValue === "#") {
    shareQr.hidden = true;
    shareQrLink.href = "#";
    shareQrImage.removeAttribute("src");
    shareQrImage.removeAttribute("data-share-url");
    return;
  }
  const qrTargetUrl = buildCompactShareUrl(rawValue);
  if (!qrTargetUrl || qrTargetUrl === "#") {
    shareQr.hidden = true;
    shareQrLink.href = "#";
    shareQrImage.removeAttribute("src");
    shareQrImage.removeAttribute("data-share-url");
    return;
  }
  if (shareQrImage.dataset.shareUrl !== qrTargetUrl) {
    shareQrImage.src = buildQrImageUrl(qrTargetUrl);
    shareQrImage.dataset.shareUrl = qrTargetUrl;
  }
  shareQrLink.href = qrTargetUrl;
  shareQr.hidden = false;
};

const clearShareUi = () => {
  if (shareButton) {
    shareButton.disabled = true;
    shareButton.dataset.url = "";
    shareButton.dataset.state = "";
  }
  updateShareQr("");
};

const loadCachePayload = (cacheKey) => {
  if (!cacheKey) return null;
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${cacheKey}`);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    return parsed?.payload || null;
  } catch (error) {
    return null;
  }
};

const saveCachePayload = (cacheKey, payload) => {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${cacheKey}`,
      JSON.stringify({ payload, cachedAt: Date.now() })
    );
  } catch (error) {
    // Ignore storage errors.
  }
};

const updateShareButton = (payload, cacheKey, fallbackUrl) => {
  const fullShareUrl = buildShareUrl({
    originalUrl: payload?.originalUrl || fallbackUrl,
    cacheKey,
    title: payload?.title,
  });
  const shareUrl = buildCompactShareUrl(fullShareUrl);
  if (shareButton) {
    shareButton.disabled = false;
    shareButton.dataset.url = shareUrl;
    shareButton.dataset.state = "";
  }
  updateShareQr(shareUrl);
  updateShareMeta(payload, shareUrl);
  syncAddressWithShareUrl(shareUrl);
};

const fixImages = (container, timestamp) => {
  if (!container) return;
  const stripArchivePrefix = (url) =>
    String(url || "").replace(/^https?:\/\/web\.archive\.org\/web\/\d{14}[a-z]{0,2}_?\//, "");
  const isValidHttpUrl = (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (error) {
      return false;
    }
  };
  const decodeUrlOnce = (value) => {
    if (!value) return "";
    try {
      return decodeURI(String(value));
    } catch (error) {
      return String(value);
    }
  };
  const normalizeHttpUrl = (value) => {
    const candidate = decodeUrlOnce(String(value || "").trim());
    if (!candidate) return "";
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.toString();
    } catch (error) {
      return "";
    }
  };
  const ensureArchiveImage = (url) => {
    const source = normalizeHttpUrl(url) || String(url || "").trim();
    if (!source) return source;
    if (source.includes("web.archive.org/web/") && !source.includes("im_/")) {
      return source.replace(/\/web\/(\d{14})([a-z]{2}_)?\//, `/web/$1im_/`);
    }
    if (timestamp && !source.includes("web.archive.org/web/")) {
      return `https://web.archive.org/web/${timestamp}im_/${source}`;
    }
    return source;
  };
  const choosePrimaryAndFallback = (rawSrc) => {
    const source = String(rawSrc || "").trim();
    if (!source) {
      return { primary: "", fallback: "" };
    }
    const archiveSrc = ensureArchiveImage(source);
    const stripped = normalizeHttpUrl(stripArchivePrefix(archiveSrc));
    const sourceUrl = normalizeHttpUrl(source);
    const hasArchiveWrapper = archiveSrc.includes("web.archive.org/web/");

    if (hasArchiveWrapper && isValidHttpUrl(archiveSrc)) {
      return {
        primary: archiveSrc,
        fallback: stripped && stripped !== archiveSrc ? stripped : "",
      };
    }
    if (sourceUrl) {
      if (isValidHttpUrl(archiveSrc) && archiveSrc !== sourceUrl) {
        return { primary: archiveSrc, fallback: sourceUrl };
      }
      return {
        primary: sourceUrl,
        fallback: stripped && stripped !== sourceUrl ? stripped : "",
      };
    }
    if (stripped) {
      return { primary: stripped, fallback: "" };
    }
    return { primary: archiveSrc || source, fallback: "" };
  };
  const attachFallback = (img) => {
    if (img.dataset.panaFallbackBound === "1") return;
    const tryFallback = () => {
      if (img.dataset.panaFallbackTried === "1") return;
      const fallback = img.dataset.fallbackSrc || "";
      if (!fallback || fallback === img.currentSrc || fallback === img.src) return;
      img.dataset.panaFallbackTried = "1";
      img.src = fallback;
    };
    img.dataset.panaFallbackBound = "1";
    img.addEventListener("error", () => {
      tryFallback();
    });
    img.addEventListener("load", () => {
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        tryFallback();
      }
    });
  };

  container.querySelectorAll("picture").forEach((picture) => {
    const img = picture.querySelector("img");
    if (img) {
      const existing = img.getAttribute("src");
      if (!existing || existing.startsWith("data:") || existing === "about:blank") {
        const source = picture.querySelector("source[srcset], source[data-srcset]");
        if (source) {
          const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset");
          if (srcset) {
            const first = srcset.split(",")[0]?.trim();
            const url = first ? first.split(/\s+/)[0] : "";
            if (url) {
              img.setAttribute("src", url);
            }
          }
        }
      }
    }
    picture.querySelectorAll("source").forEach((sourceNode) => sourceNode.remove());
  });

  container.querySelectorAll("img").forEach((img) => {
    let src = img.getAttribute("src");
    if (!src || src.startsWith("data:") || src === "about:blank") {
      src =
        img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-orig-src");
    }
    if (!src) {
      const srcset =
        img.getAttribute("srcset") ||
        img.getAttribute("data-srcset") ||
        img.getAttribute("data-original-srcset");
      if (srcset) {
        src = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      }
    }
    if (src) {
      const { primary, fallback } = choosePrimaryAndFallback(src);
      if (primary) {
        img.setAttribute("src", primary);
      }
      if (fallback) {
        img.dataset.fallbackSrc = fallback;
      } else {
        img.dataset.fallbackSrc = "";
      }
    }
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.setAttribute("referrerpolicy", "no-referrer");
    attachFallback(img);
  });
};

const renderContentHtml = (container, html, timestamp) => {
  if (!container) return;
  const staging = document.createElement("div");
  staging.innerHTML = html || "";
  fixImages(staging, timestamp);
  container.replaceChildren();
  while (staging.firstChild) {
    container.appendChild(staging.firstChild);
  }
};

const applyPayload = (payload, { fromCache = false } = {}) => {
  const headline = payload.title || "Archived page";
  titleEl.textContent = headline;
  if (headline) {
    document.title = headline;
  }
  bylineEl.textContent = buildTitleMeta({
    byline: payload.byline,
    excerpt: payload.excerpt,
    publishedDate: payload.publishedDate,
  });
  archiveLink.href = payload.archiveUrl;
  originalUrl.textContent = payload.originalUrl || "";

  if (archiveSource) {
    if (payload.archiveSource) {
      archiveSource.textContent =
        payload.archiveSource === "cdx"
          ? "Source: Wayback CDX index"
          : "Source: Wayback availability API";
    } else {
      archiveSource.textContent = "";
    }
  }

  renderContentHtml(contentEl, payload.contentHtml, payload.archiveTimestamp);
  setReaderWarning(payload.extractionWarning);
  if (fromCache) {
    setStatus("Loaded from cache.", "success");
  } else {
    setStatus("", "info");
  }
};

const params = new URLSearchParams(window.location.search);
const url = params.get("url");
const cacheKeyFromPath = (() => {
  const match = window.location.pathname.match(/^\/s\/([^/?#]+)/);
  if (!match || !match[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return match[1];
  }
})();
let cacheKey = params.get("cache") || cacheKeyFromPath;
clearShareUi();

const cached = cacheKey ? loadCachePayload(cacheKey) : null;
if (cached) {
  applyPayload(cached, { fromCache: true });
  updateShareButton(cached, cacheKey, url);
} else if (!url) {
  titleEl.textContent = "Missing URL";
  document.title = "Missing URL";
  clearShareUi();
  setStatus("Add ?url= to the address, or go back to the homepage.", "error");
} else {
  setStatus("Loading archived reader view...", "loading");

  fetch(`/.netlify/functions/archive?url=${encodeURIComponent(url)}`)
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || "Unable to load the archived page.");
      }
      if (data.status === "blocked") {
        titleEl.textContent = "Archive unavailable";
        document.title = "Archive unavailable";
        clearShareUi();
        const submission = data.submission || {};
        const suffix = submission.statusCode ? ` (${submission.statusCode})` : "";
        const detail = submission.label
          ? `${submission.label}${suffix}.`
          : "Wayback could not archive this URL.";
        setStatus(detail, "error");
        if (submission.detail) {
          contentEl.innerHTML = "";
          const p = document.createElement("p");
          p.textContent = submission.detail;
          contentEl.appendChild(p);
        }
        return;
      }
      if (data.status === "submitted") {
        titleEl.textContent = "Archive submitted";
        document.title = "Archive submitted";
        clearShareUi();
        setStatus(data.message || "Archive submitted.", "info");
        if (data.archiveUrl) {
          archiveLink.href = data.archiveUrl;
          originalUrl.textContent = data.originalUrl;
        }
        return;
      }
      if (data.status === "archived_link_only") {
        titleEl.textContent = data.title || "Archived snapshot";
        document.title = titleEl.textContent;
        clearShareUi();
        archiveLink.href = data.archiveUrl || "#";
        originalUrl.textContent = data.originalUrl || url;
        bylineEl.textContent = "";
        contentEl.innerHTML =
          "<p>Wayback has a snapshot, but clean extraction is unavailable right now. Use the snapshot link above.</p>";
        setReaderWarning(null);
        setStatus(
          data.message || "Archive snapshot found, but clean reader extraction is unavailable.",
          "info"
        );
        return;
      }
      if (data.status !== "archived") {
        throw new Error("Unexpected response from the archive service.");
      }

      const payload = {
        title: data.title,
        byline: data.byline,
        excerpt: data.excerpt,
        contentHtml: data.contentHtml,
        archiveUrl: data.archiveUrl,
        archiveTimestamp: data.archiveTimestamp,
        archiveSource: data.archiveSource,
        originalUrl: data.originalUrl,
        heroImage: data.heroImage,
        publishedDate: data.publishedDate,
        extractionWarning: data.extractionWarning,
      };

      if (!cacheKey) {
        cacheKey = buildCacheKey(payload);
      }
      saveCachePayload(cacheKey, payload);

      applyPayload(payload);
      updateShareButton(payload, cacheKey, url);
    })
    .catch((error) => {
      titleEl.textContent = "Could not load reader view";
      document.title = "Could not load reader view";
      clearShareUi();
      setStatus(error.message, "error");
    });
}

if (shareButton) {
  shareButton.addEventListener("click", async () => {
    const shareUrl = shareButton.dataset.url;
    if (!shareUrl || shareUrl === "#") {
      setStatus("No share link to copy yet.", "error");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const temp = document.createElement("textarea");
        temp.value = shareUrl;
        temp.setAttribute("readonly", "");
        temp.style.position = "absolute";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.select();
        document.execCommand("copy");
        document.body.removeChild(temp);
      }
      shareButton.dataset.state = "copied";
      setStatus("Share link copied to clipboard.", "success");
      setTimeout(() => {
        shareButton.dataset.state = "";
      }, 2000);
    } catch (error) {
      setStatus("Unable to copy the share link.", "error");
    }
  });
}
