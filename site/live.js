const form = document.getElementById("live-form");
const input = document.getElementById("live-url-input");
const statusEl = document.getElementById("live-status");
const resultEl = document.getElementById("live-result");
const titleEl = document.getElementById("live-title");
const bylineEl = document.getElementById("live-byline");
const pageLink = document.getElementById("page-link");
const sourceEl = document.getElementById("live-source");
const urlEl = document.getElementById("live-url");
const contentEl = document.getElementById("live-content");
const warningEl = document.getElementById("live-warning");
const copyButton = document.getElementById("copy-button");
const qrWrap = document.getElementById("live-qr");
const qrLink = document.getElementById("live-qr-link");
const qrImage = document.getElementById("live-qr-image");
const DEFAULT_TITLE = "Live Link Preview";

const setStatus = (message, type = "info") => {
  statusEl.textContent = message || "";
  statusEl.dataset.type = type;
};

const isValidHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
};

const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

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

const setWarning = (warning) => {
  const message = String(warning?.message || "").trim();
  if (!message) {
    warningEl.textContent = "";
    warningEl.classList.add("hidden");
    return;
  }
  warningEl.textContent = message;
  warningEl.classList.remove("hidden");
};

const buildQrImageUrl = (value) => {
  const target = new URL("https://api.qrserver.com/v1/create-qr-code/");
  target.searchParams.set("size", "320x320");
  target.searchParams.set("margin", "0");
  target.searchParams.set("ecc", "L");
  target.searchParams.set("data", value);
  return target.toString();
};

const updateQr = (url) => {
  const safeUrl = String(url || "").trim();
  if (!safeUrl || safeUrl === "#") {
    qrWrap.hidden = true;
    qrLink.href = "#";
    qrImage.removeAttribute("src");
    qrImage.removeAttribute("data-qr-url");
    return;
  }
  if (qrImage.dataset.qrUrl !== safeUrl) {
    qrImage.src = buildQrImageUrl(safeUrl);
    qrImage.dataset.qrUrl = safeUrl;
  }
  qrLink.href = safeUrl;
  qrWrap.hidden = false;
};

const scrollPreviewIntoView = () => {
  if (resultEl.classList.contains("hidden")) return;
  requestAnimationFrame(() => {
    resultEl.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
};

const resetPreview = () => {
  resultEl.classList.add("hidden");
  document.title = DEFAULT_TITLE;
  titleEl.textContent = "";
  bylineEl.textContent = "";
  pageLink.href = "#";
  sourceEl.textContent = "";
  urlEl.textContent = "";
  contentEl.innerHTML = "";
  setWarning(null);
  if (copyButton) {
    copyButton.disabled = true;
    copyButton.dataset.url = "";
    copyButton.dataset.state = "";
  }
  updateQr("");
};

const syncAddressWithUrl = (url) => {
  const next = new URL(window.location.href);
  if (url) {
    next.searchParams.set("url", url);
  } else {
    next.searchParams.delete("url");
  }
  if (next.toString() !== window.location.href) {
    window.history.replaceState(null, "", next.toString());
  }
};

const renderContentHtml = (html) => {
  const staging = document.createElement("div");
  staging.innerHTML = html || "";
  staging.querySelectorAll("img").forEach((img) => {
    img.setAttribute("referrerpolicy", "no-referrer");
  });
  contentEl.replaceChildren();
  while (staging.firstChild) {
    contentEl.appendChild(staging.firstChild);
  }
};

const buildSourceLine = (payload) => {
  const parts = [];
  const publicationName = normalizeText(payload?.publicationName);
  if (publicationName) {
    parts.push(publicationName);
  }
  if (payload?.resolvedUrl && payload.resolvedUrl !== payload.originalUrl) {
    if (payload?.queryNormalization?.removedTrackingParams?.length) {
      parts.push("QR uses a normalized URL");
    } else {
      parts.push("QR uses the resolved live URL");
    }
  }
  return parts.join(" • ");
};

const applyPayload = (payload) => {
  const pageUrl = String(payload?.pageUrl || payload?.resolvedUrl || payload?.originalUrl || "").trim();
  titleEl.textContent = payload?.title || "Live preview";
  document.title = titleEl.textContent;
  bylineEl.textContent = buildTitleMeta({
    byline: payload?.byline,
    excerpt: payload?.excerpt,
    publishedDate: payload?.publishedDate,
  });
  pageLink.href = pageUrl || "#";
  sourceEl.textContent = buildSourceLine(payload);
  urlEl.textContent = pageUrl || payload?.originalUrl || "";
  renderContentHtml(payload?.contentHtml || "");
  setWarning(payload?.extractionWarning || null);
  updateQr(pageUrl);
  if (copyButton) {
    copyButton.disabled = !pageUrl;
    copyButton.dataset.url = pageUrl;
    copyButton.dataset.state = "";
  }
  resultEl.classList.remove("hidden");
};

const loadPreview = async (url) => {
  const response = await fetch(`/.netlify/functions/live-preview?url=${encodeURIComponent(url)}`);
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`Preview request failed (${response.status}).`);
  }
  if (!response.ok || data.error) {
    throw new Error(data.error || `Preview request failed (${response.status}).`);
  }
  if (data.status !== "previewed") {
    throw new Error("Unexpected response from the live preview service.");
  }
  return data;
};

if (copyButton) {
  copyButton.addEventListener("click", async () => {
    const url = copyButton.dataset.url;
    if (!url || url === "#") {
      setStatus("No URL to copy yet.", "error");
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
      copyButton.dataset.state = "copied";
      setStatus("Original URL copied to clipboard.", "success");
      setTimeout(() => {
        copyButton.dataset.state = "";
      }, 2000);
    } catch (error) {
      setStatus("Unable to copy the original URL.", "error");
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = input.value || "";
  const url = raw.replace(/\s+/g, "").trim();
  if (!url) {
    setStatus("Enter a URL to generate the live preview.", "error");
    resetPreview();
    syncAddressWithUrl("");
    return;
  }
  if (!isValidHttpUrl(url)) {
    setStatus("Enter a valid URL starting with http:// or https://", "error");
    resetPreview();
    return;
  }

  resetPreview();
  setStatus("Generating live preview...", "loading");
  form.classList.add("loading");
  syncAddressWithUrl(url);

  try {
    const payload = await loadPreview(url);
    applyPayload(payload);
    setStatus("Live preview ready.", "success");
    scrollPreviewIntoView();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    form.classList.remove("loading");
  }
});

const initialUrl = new URLSearchParams(window.location.search).get("url");
if (initialUrl) {
  input.value = initialUrl;
  form.requestSubmit();
}
