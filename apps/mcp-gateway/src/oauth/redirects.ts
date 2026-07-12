const CHATGPT_HOST = "chatgpt.com";
const CHATGPT_LEGACY_PATH = "/connector_platform_oauth_redirect";
const CHATGPT_CALLBACK_PREFIX = "/connector/oauth/";

const PERPLEXITY_HOSTS = new Set([
  "www.perplexity.ai",
  "www.perplexity.com",
  "enterprise.perplexity.ai"
]);
const PERPLEXITY_CALLBACK_PATH = "/rest/connections/oauth_callback";

function isSecureOrigin(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "";
}

function isAllowedChatGptRedirect(url: URL): boolean {
  if (url.hostname !== CHATGPT_HOST) return false;
  if (url.pathname === CHATGPT_LEGACY_PATH) return true;
  return url.pathname.startsWith(CHATGPT_CALLBACK_PREFIX) && url.pathname.length > CHATGPT_CALLBACK_PREFIX.length;
}

function isAllowedPerplexityRedirect(url: URL): boolean {
  return PERPLEXITY_HOSTS.has(url.hostname) && url.pathname === PERPLEXITY_CALLBACK_PATH;
}

export function isAllowedHost(url: URL): boolean {
  return isSecureOrigin(url) && (url.hostname === CHATGPT_HOST || PERPLEXITY_HOSTS.has(url.hostname));
}

export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!isSecureOrigin(url)) return false;
  return isAllowedChatGptRedirect(url) || isAllowedPerplexityRedirect(url);
}
