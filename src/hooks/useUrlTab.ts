import { useCallback, useEffect, useState } from "react";
import { appPathname, toUrlPath } from "../lib/basePath";

export function tabIdFromPathname(pathname: string): string {
  const segment = pathname.replace(/^\/+/, "").split("/")[0];
  return segment || "home";
}

export function pathnameFromTabId(tabId: string): string {
  return tabId === "home" ? "/" : `/${tabId}`;
}

/**
 * Keeps the active tab in sync with the URL path (e.g. /keymap) so tabs
 * are reachable via direct links, browser back/forward, and sharing.
 */
export function useUrlTab(): [string, (tabId: string) => void] {
  const [tabId, setTabId] = useState(() => tabIdFromPathname(appPathname()));

  useEffect(() => {
    const onPopState = () => setTabId(tabIdFromPathname(appPathname()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextTabId: string) => {
    const path = toUrlPath(pathnameFromTabId(nextTabId));
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    setTabId(nextTabId);
  }, []);

  return [tabId, navigate];
}
