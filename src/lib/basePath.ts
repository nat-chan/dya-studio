/**
 * Base-path aware routing helpers.
 *
 * The app's routes are root-relative ("/keymap", "/release-notes", ...) but
 * the site may be deployed under a URL prefix (e.g. GitHub Pages serves it
 * at /dya-studio/). These helpers translate between the two so route logic
 * stays prefix-agnostic. With a root deployment (BASE_PATH === "") both are
 * identity functions.
 */
import { BASE_PATH } from "./viteEnv";

/**
 * The browser pathname with the deployment prefix stripped — the app-route
 * form used for comparisons ("/", "/keymap", "/developer-guide/...").
 */
export function appPathname(
  pathname: string = window.location.pathname,
): string {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    const stripped = pathname.slice(BASE_PATH.length);
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  return pathname;
}

/** An app route as a browser URL path, with the deployment prefix applied. */
export function toUrlPath(appPath: string): string {
  return `${BASE_PATH}${appPath}`;
}
