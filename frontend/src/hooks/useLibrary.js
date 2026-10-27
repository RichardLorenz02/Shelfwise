import { api, qs } from "../api/client";
import { useAsync } from "./useAsync";

let cache = null;

/** Show the last public snapshot immediately, refresh it on entry, and batch remaining pages. */
export function useLibrary() {
  const r = useAsync(async (signal) => {
    const get = (page) =>
      api.get(`/books${qs({ sort: "title", limit: 100, page })}`, { signal });
    const first = await get(1);
    const pages = [first.data],
      last = Math.min(first.pages || 1, 100);
    for (let p = 2; p <= last; p += 4) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(4, last - p + 1) }, (_, i) => get(p + i)),
      );
      pages.push(...batch.map((result) => result.data));
    }
    if (signal.aborted)
      throw new DOMException("Request cancelled", "AbortError");
    cache = pages.flat();
    return cache;
  }, []);
  return { ...r, data: r.data || cache };
}
