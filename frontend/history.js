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

const libraryLimit = 200;

export function savedArticles() {
  if (!cache.has('library')) {
    let saved = [];
    try {
      const stored = JSON.parse(localStorage.getItem(key('library')) ?? '[]');
      if (Array.isArray(stored)) saved = stored.filter(article =>
        typeof article?.pmid === 'string' && /^[1-9]\d{0,11}$/.test(article.pmid) && Array.isArray(article.authors));
    } catch {
      // A blocked or invalid store starts with an empty library.
    }
    cache.set('library', saved.slice(0, libraryLimit));
  }
  return cache.get('library');
}

export function changeLibrary(article) {
  const saved = savedArticles();
  const exists = saved.some(item => item.pmid === article.pmid);
  if (!exists && saved.length >= libraryLimit) throw new Error('文献库已达 200 篇，请先移除不需要的记录。');
  const next = exists ? saved.filter(item => item.pmid !== article.pmid) : [article, ...saved];
  try {
    localStorage.setItem(key('library'), JSON.stringify(next));
  } catch {
    throw new Error('浏览器无法保存文献库，请检查存储权限或可用空间。');
  }
  cache.set('library', next);
  return !exists;
}
