// The app is served under next.config.ts basePath "/nb". Next rewrites page
// routes and <Link> for that automatically, but a plain fetch("/api/...") does
// not get the prefix and 404s. Every client-side fetch goes through here.
export const BASE_PATH = "/nb";

export function apiPath(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiPath(path), init);
}
