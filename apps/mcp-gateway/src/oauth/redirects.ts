const ALLOWED_HOST = "chatgpt.com";
const LEGACY_PATH = "/connector_platform_oauth_redirect";
const CALLBACK_PREFIX = "/connector/oauth/";

export function isAllowedHost(url: URL): boolean {
  return url.protocol === "https:" && url.hostname === ALLOWED_HOST && url.username === "" && url.password === "" && url.port === "";
}

export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!isAllowedHost(url)) return false;
  if (url.pathname === LEGACY_PATH) return true;
  return url.pathname.startsWith(CALLBACK_PREFIX) && url.pathname.length > CALLBACK_PREFIX.length;
}
