const titleEl = document.getElementById("reader-title");
const bylineEl = document.getElementById("reader-byline");
const archiveLink = document.getElementById("archive-link");
const archiveSource = document.getElementById("archive-source");
const originalUrl = document.getElementById("original-url");
const contentEl = document.getElementById("reader-content");
const statusEl = document.getElementById("reader-status");
const shareButton = document.getElementById("share-button");

const CACHE_PREFIX = "webArchiveCache:";

const setStatus = (message, type = "info") => {
  statusEl.textContent = message || "";
  statusEl.dataset.type = type;
};

const buildCacheKey = (payload) => {
  const seed = `${payload.archiveTimestamp || ""}|${payload.originalUrl || ""}`;
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

const updateShareButton = (url, cacheKey) => {
  if (!shareButton) return;
  const shareUrl = buildReaderUrl(url, cacheKey);
  shareButton.disabled = false;
  shareButton.dataset.url = shareUrl;
  shareButton.dataset.state = "";
};

const fixImages = (container, timestamp) => {
  if (!container) return;
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

  container.querySelectorAll("picture").forEach((picture) => {
    const img = picture.querySelector("img");
    if (!img) return;
    const existing = img.getAttribute("src");
    if (existing && !existing.startsWith("data:") && existing !== "about:blank") {
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
      img.setAttribute("src", ensureArchiveImage(src));
    }
  });
};

const applyPayload = (payload, { fromCache = false } = {}) => {
  titleEl.textContent = payload.title || "Archived page";
  bylineEl.textContent = payload.byline || payload.excerpt || "";
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
  updateShareButton(cached.originalUrl || url, cacheKey);
} else if (!url) {
  titleEl.textContent = "Missing URL";
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
      };

      if (!cacheKey) {
        cacheKey = buildCacheKey(payload);
      }
      saveCachePayload(cacheKey, payload);

      applyPayload(payload);
      updateShareButton(payload.originalUrl || url, cacheKey);

      const nextUrl = buildReaderUrl(payload.originalUrl || url, cacheKey);
      if (nextUrl && window.location.href !== nextUrl) {
        window.history.replaceState(null, "", nextUrl);
      }
    })
    .catch((error) => {
      titleEl.textContent = "Could not load reader view";
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
