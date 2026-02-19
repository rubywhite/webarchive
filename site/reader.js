const titleEl = document.getElementById("reader-title");
const bylineEl = document.getElementById("reader-byline");
const archiveLink = document.getElementById("archive-link");
const archiveSource = document.getElementById("archive-source");
const originalUrl = document.getElementById("original-url");
const contentEl = document.getElementById("reader-content");
const statusEl = document.getElementById("reader-status");
const shareButton = document.getElementById("share-button");
const readerWarning = document.getElementById("reader-warning");

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

const buildReaderUrl = (url, cacheKey) => {
  const target = new URL("/reader.html", window.location.origin);
  if (url) {
    target.searchParams.set("url", url);
  }
  if (cacheKey) {
    target.searchParams.set("cache", cacheKey);
  }
  return target.toString();
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

const buildShareUrl = ({ originalUrl: pageUrl, cacheKey, title, excerpt, image }) => {
  const target = new URL(cacheKey ? `/s/${encodeURIComponent(cacheKey)}` : "/s", window.location.origin);
  if (pageUrl) target.searchParams.set("url", pageUrl);
  const cleanTitle = normalizeShareText(title, 180);
  const cleanExcerpt = normalizeShareText(excerpt, 280);
  if (cleanTitle) target.searchParams.set("title", cleanTitle);
  if (cleanExcerpt) target.searchParams.set("excerpt", cleanExcerpt);
  if (image) target.searchParams.set("image", image);
  return target.toString();
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
  if (!shareButton) return;
  const shareUrl = buildShareUrl({
    originalUrl: payload?.originalUrl || fallbackUrl,
    cacheKey,
    title: payload?.title,
    excerpt: payload?.excerpt || payload?.byline,
    image: payload?.heroImage,
  });
  shareButton.disabled = false;
  shareButton.dataset.url = shareUrl;
  shareButton.dataset.state = "";
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
  const ensureArchiveImage = (url) => {
    if (!url) return url;
    if (url.includes("web.archive.org/web/") && !url.includes("im_/")) {
      return url.replace(/\/web\/(\d{14})([a-z]{2}_)?\//, `/web/$1im_/`);
    }
    if (timestamp && !url.includes("web.archive.org/web/")) {
      return `https://web.archive.org/web/${timestamp}im_/${encodeURI(url)}`;
    }
    return url;
  };
  const choosePrimaryAndFallback = (rawSrc) => {
    const source = String(rawSrc || "").trim();
    if (!source) {
      return { primary: "", fallback: "" };
    }
    const archiveSrc = ensureArchiveImage(source);
    const stripped = stripArchivePrefix(archiveSrc);
    const hasArchiveWrapper = archiveSrc.includes("web.archive.org/web/");

    if (hasArchiveWrapper && isValidHttpUrl(stripped)) {
      return { primary: stripped, fallback: archiveSrc === stripped ? "" : archiveSrc };
    }
    if (isValidHttpUrl(source)) {
      return { primary: source, fallback: archiveSrc !== source ? archiveSrc : "" };
    }
    if (isValidHttpUrl(stripped)) {
      return { primary: stripped, fallback: archiveSrc !== stripped ? archiveSrc : "" };
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

  contentEl.innerHTML = payload.contentHtml || "";
  fixImages(contentEl, payload.archiveTimestamp);
  setReaderWarning(payload.extractionWarning);
  if (fromCache) {
    setStatus("Loaded from cache.", "success");
  } else {
    setStatus("", "info");
  }
};

const params = new URLSearchParams(window.location.search);
const url = params.get("url");
let cacheKey = params.get("cache");

const cached = cacheKey ? loadCachePayload(cacheKey) : null;
if (cached) {
  applyPayload(cached, { fromCache: true });
  updateShareButton(cached, cacheKey, url);
} else if (!url) {
  titleEl.textContent = "Missing URL";
  document.title = "Missing URL";
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
        setStatus(data.message || "Archive submitted.", "info");
        if (data.archiveUrl) {
          archiveLink.href = data.archiveUrl;
          originalUrl.textContent = data.originalUrl;
        }
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

      const nextUrl = buildReaderUrl(payload.originalUrl || url, cacheKey);
      if (nextUrl && window.location.href !== nextUrl) {
        window.history.replaceState(null, "", nextUrl);
      }
    })
    .catch((error) => {
      titleEl.textContent = "Could not load reader view";
      document.title = "Could not load reader view";
      setStatus(error.message, "error");
    });
}

if (shareButton) {
  shareButton.addEventListener("click", async () => {
    const shareUrl = shareButton.dataset.url;
    if (!shareUrl || shareUrl === "#") {
      setStatus("No cache link to copy yet.", "error");
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
      setStatus("Cache link copied to clipboard.", "success");
      setTimeout(() => {
        shareButton.dataset.state = "";
      }, 2000);
    } catch (error) {
      setStatus("Unable to copy the cache link.", "error");
    }
  });
}
