const dns = require("node:dns").promises;
const net = require("node:net");

const USER_AGENT = "WebArchiveOgImage/1.0";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 8_000_000;

function response(statusCode, headers = {}, body = "", isBase64Encoded = false) {
  return {
    statusCode,
    headers,
    body,
    isBase64Encoded,
  };
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

function stripWaybackImageWrapper(value) {
  return String(value || "").replace(
    /^https?:\/\/web\.archive\.org\/web\/\d{14}[a-z]{0,2}_?\//i,
    ""
  );
}

function normalizeImageUrl(value) {
  const stripped = stripWaybackImageWrapper(value);
  if (!stripped) return "";
  try {
    const parsed = new URL(stripped);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function isPrivateIp(address) {
  const family = net.isIP(address);
  if (!family) return false;

  if (family === 4) {
    const [a, b] = address.split(".").map((part) => Number(part));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  const value = address.toLowerCase();
  if (value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) {
    return true;
  }
  return false;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0") return true;
  if (net.isIP(host)) {
    return isPrivateIp(host);
  }
  return false;
}

async function resolvesToPrivateIp(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.some((entry) => isPrivateIp(entry.address));
  } catch (error) {
    return false;
  }
}

async function isAllowedTarget(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    if (isBlockedHostname(parsed.hostname)) {
      return false;
    }
    if (await resolvesToPrivateIp(parsed.hostname)) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
}

function fallbackRedirect(origin) {
  const fallback = origin ? `${origin}/RubyWhite.png` : "/RubyWhite.png";
  return response(
    302,
    {
      location: fallback,
      "cache-control": "public, max-age=300",
    },
    ""
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

async function fetchFollowingRedirects(targetUrl) {
  let currentUrl = targetUrl;
  for (let index = 0; index <= MAX_REDIRECTS; index += 1) {
    const upstream = await fetchWithTimeout(
      currentUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "image/*,*/*;q=0.8",
        },
      },
      FETCH_TIMEOUT_MS
    );

    if (isRedirectStatus(upstream.status)) {
      const location = upstream.headers.get("location");
      if (!location) return null;
      const nextUrl = new URL(location, currentUrl).toString();
      if (!(await isAllowedTarget(nextUrl))) return null;
      currentUrl = nextUrl;
      continue;
    }

    return upstream;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return response(405, { "cache-control": "no-store" }, "");
  }

  const origin = resolveOrigin(event);
  const rawSrc = String(event.queryStringParameters?.src || "");
  const targetUrl = normalizeImageUrl(rawSrc);
  if (!targetUrl) {
    return fallbackRedirect(origin);
  }
  if (!(await isAllowedTarget(targetUrl))) {
    return fallbackRedirect(origin);
  }

  try {
    const upstream = await fetchFollowingRedirects(targetUrl);
    if (!upstream || !upstream.ok) {
      return fallbackRedirect(origin);
    }

    const contentType = String(upstream.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) {
      return fallbackRedirect(origin);
    }

    const contentLengthHeader = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(contentLengthHeader) && contentLengthHeader > MAX_IMAGE_BYTES) {
      return fallbackRedirect(origin);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
      return fallbackRedirect(origin);
    }

    return response(
      200,
      {
        "content-type": contentType,
        "content-length": String(buffer.length),
        "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000",
        "x-content-type-options": "nosniff",
      },
      buffer.toString("base64"),
      true
    );
  } catch (error) {
    return fallbackRedirect(origin);
  }
};
