const defaultApi = 'http://localhost:8080';
const apiOrigin = window.MED_EVIDENCE_API_ORIGIN ?? defaultApi;
const namespace = apiOrigin === defaultApi ? '' : ':' + encodeURIComponent(apiOrigin);
const key = kind => 'medevidence:' + kind + ':v1' + namespace;
const cache = new Map();
const limit = 8;

export function recent(kind) {
  if (!cache.has(kind)) {
    let entries = [];
    try {
      const stored = JSON.parse(localStorage.getItem(key(kind)) ?? '[]');
      if (Array.isArray(stored)) entries = stored.filter(item =>
        typeof item?.id === 'string' && typeof item.question === 'string' && Number.isFinite(item.at)
        && (kind === 'tasks' || (item.request?.query === item.question && Number.isInteger(item.total))));
    } catch {
      // The session still works when browser storage is disabled or unavailable.
    }
    cache.set(kind, entries.slice(0, limit));
  }
  return cache.get(kind);
}

function save(kind, entries) {
  cache.set(kind, entries);
  try {
    localStorage.setItem(key(kind), JSON.stringify(entries));
  } catch {
    // Retain the in-memory history for this session.
  }
}

export function remember(kind, item) {
  const entries = recent(kind);
  const previous = entries.find(entry => entry.id === item.id);
  save(kind, [{ ...item, at: item.at ?? previous?.at ?? Date.now() },
    ...entries.filter(entry => entry.id !== item.id)].slice(0, limit));
}

export function clearRecent(kind) {
  save(kind, []);
}
