const form = document.getElementById("archive-form");
const input = document.getElementById("url-input");
const statusEl = document.getElementById("status");
const resultSection = document.getElementById("result");
const readerTitle = document.getElementById("reader-title");
const readerByline = document.getElementById("reader-byline");
const archiveLink = document.getElementById("archive-link");
const readerLink = document.getElementById("reader-link");
const shareButton = document.getElementById("share-button");
const archiveSource = document.getElementById("archive-source");
const originalUrl = document.getElementById("original-url");
const readerContent = document.getElementById("reader-content");

const CACHE_PREFIX = "webArchiveCache:";
const CACHE_INDEX_KEY = "webArchiveCacheIndex";

const setStatus = (message, type = "info") => {
  statusEl.textContent = message || "";
  statusEl.dataset.type = type;
};

const normalizeUrl = (value) => value.trim();

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
};

const loadCacheIndex = () => {
  try {
    const stored = localStorage.getItem(CACHE_INDEX_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch (error) {
    return {};
  }
};

const saveCacheIndex = (index) => {
  localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
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

const saveCachePayload = (cacheKey, payload) => {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${cacheKey}`,
      JSON.stringify({ payload, cachedAt: Date.now() })
    );
    if (payload?.originalUrl) {
      const index = loadCacheIndex();
      index[payload.originalUrl] = cacheKey;
      saveCacheIndex(index);
    }
  } catch (error) {
    // Ignore storage errors (private mode, quota exceeded, etc.)
  }
};

const buildReaderUrl = (url, cacheKey) => {
  const target = new URL("/reader.html", window.location.origin);
  target.searchParams.set("url", url);
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

const resetResult = () => {
  resultSection.classList.add("hidden");
  readerTitle.textContent = "";
  readerByline.textContent = "";
  archiveLink.href = "#";
  archiveLink.textContent = "View on web.archive.org";
  readerLink.href = "#";
  readerLink.textContent = "Open clean reader view";
  if (shareButton) {
    shareButton.disabled = true;
    shareButton.dataset.state = "";
    shareButton.dataset.url = "";
  }
  if (archiveSource) {
    archiveSource.textContent = "";
  }
  originalUrl.textContent = "";
  readerContent.innerHTML = "";
};

const fixImagesInContainer = (container, timestamp) => {
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

const checkArchiveForUrl = async (url) => {
  const response = await fetch(`/.netlify/functions/archive?url=${encodeURIComponent(url)}`);
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Archive check failed (${response.status}).`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Archive check failed (${response.status}).`);
  }

  resetResult();

  if (data.status === "blocked") {
    const submission = data.submission || {};
    const suffix = submission.statusCode ? ` (${submission.statusCode})` : "";
    const message = submission.label
      ? `${submission.label}${suffix}.`
      : "Wayback could not archive this URL.";
    setStatus(message, "error");
    return;
  }

  if (data.status === "submitted") {
    setStatus("Not archived yet. We submitted it to the Wayback Machine.", "info");
    if (data.archiveUrl) {
      archiveLink.href = data.archiveUrl;
      archiveLink.textContent = "View the archived snapshot";
      originalUrl.textContent = data.originalUrl;
      readerContent.innerHTML =
        "<p>The archive is warming up. Check the snapshot link for the stored page.</p>";
      resultSection.classList.remove("hidden");
    }
    return;
  }

  if (data.status !== "archived") {
    throw new Error("Unexpected response from the archive service.");
  }

  setStatus("Archive found. Loading reader view...", "success");
  readerTitle.textContent = data.title || "Archived page";
  readerByline.textContent = data.byline || data.excerpt || "";
  archiveLink.href = data.archiveUrl;

  const cachePayload = {
    title: data.title,
    byline: data.byline,
    excerpt: data.excerpt,
    contentHtml: data.contentHtml,
    archiveUrl: data.archiveUrl,
    archiveTimestamp: data.archiveTimestamp,
    archiveSource: data.archiveSource,
    originalUrl: data.originalUrl,
    heroImage: data.heroImage,
  };
  const cacheKey = buildCacheKey(cachePayload);
  saveCachePayload(cacheKey, cachePayload);

  const readerUrl = buildReaderUrl(data.originalUrl, cacheKey);
  const shareUrl = buildShareUrl({
    originalUrl: data.originalUrl,
    cacheKey,
    title: data.title,
    excerpt: data.excerpt || data.byline,
    image: data.heroImage,
  });
  readerLink.href = readerUrl;
  readerLink.textContent = "Open clean reader view";
  if (shareButton) {
    shareButton.disabled = false;
    shareButton.dataset.url = shareUrl;
    shareButton.dataset.state = "";
  }

  if (archiveSource) {
    if (data.archiveSource) {
      archiveSource.textContent =
        data.archiveSource === "cdx"
          ? "Source: Wayback CDX index"
          : "Source: Wayback availability API";
    } else {
      archiveSource.textContent = "";
    }
  }

  originalUrl.textContent = data.originalUrl;
  readerContent.innerHTML = data.contentHtml;
  fixImagesInContainer(readerContent, data.archiveTimestamp);
  resultSection.classList.remove("hidden");
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = input.value || "";
  const url = raw.replace(/\s+/g, "").trim();
  if (!url) {
    setStatus("Enter a URL to check the archive.", "error");
    return;
  }
  if (!isValidHttpUrl(url)) {
    setStatus("Enter a valid URL starting with http:// or https://", "error");
    return;
  }

  setStatus("Checking the Wayback Machine...", "loading");
  form.classList.add("loading");

  try {
    await checkArchiveForUrl(url);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    form.classList.remove("loading");
  }
});

if (shareButton) {
  shareButton.addEventListener("click", async () => {
    const url = shareButton.dataset.url;
    if (!url || url === "#") {
      setStatus("No cache link to copy yet.", "error");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const temp = document.createElement("textarea");
        temp.value = url;
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
