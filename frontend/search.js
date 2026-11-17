import { recent, remember, clearRecent, savedArticles, changeLibrary } from './history.js';
import { citation, downloadText, literatureBibtex, literatureMarkdown, markdownText } from './exports.js';

const apiOrigin = window.MED_EVIDENCE_API_ORIGIN ?? 'http://localhost:8080';
const byId = id => document.getElementById(id);
const form = byId('search');
const results = byId('results');
const status = byId('status');
const homeStatus = byId('home-status');
const reviewStatus = byId('review-status');
const selected = new Map();
let articles = [];
let rankings = new Map();
let question = '';
let lastRequest = null;
let pageResult = null;
let reranking = false;
let semanticOrder = null;
let currentReview = null;
let searching = false;
let reviewing = false;
let capabilities = { semantic: false, review: false };

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function pubmed(pmid, label = `PMID ${pmid}`) {
  const link = element('a', label);
  link.href = 'https://pubmed.ncbi.nlm.nih.gov/' + encodeURIComponent(pmid) + '/';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

async function api(path, body, timeout = 12000) {
  try {
    const post = body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const response = await fetch(apiOrigin + '/api' + path, { ...post, signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code });
    return result;
  } catch (error) {
    if (error.code && typeof error.code === 'string') throw error;
    throw new Error('无法获取服务响应，请检查后端与网络后重试。');
  }
}

function updateReviewButton() {
  byId('review-button').disabled = searching || reviewing || reranking || !capabilities.review || selected.size === 0;
}

function renderSelected() {
  const list = byId('selected');
  list.replaceChildren();
  byId('clear-selection').hidden = selected.size === 0;
  byId('clear-selection').disabled = reviewing || searching;
  byId('selected-total').textContent = selected.size;
  byId('literature-selection').hidden = selected.size === 0;
  byId('literature-selection-count').textContent = `已选 ${selected.size} / 10 篇`;
  byId('clear-literature-selection').disabled = reviewing || searching;
  byId('literature-export').hidden = selected.size === 0;
  for (const article of selected.values()) {
    const line = element('div');
    const remove = element('button', '移除', 'detail-back');
    remove.type = 'button';
    remove.disabled = reviewing;
    remove.setAttribute('aria-label', '移除 ' + (article.title ?? article.pmid));
    remove.onclick = () => {
      selected.delete(article.pmid);
      renderSelected();
      renderResults();
    };
    line.append(pubmed(article.pmid, article.title ?? article.pmid), remove);
    list.append(line);
  }
  updateReviewButton();
}

function renderPaperDetail(article) {
  const target = byId('paper-detail-content');
  const title = article.title ?? '标题未收录';
  byId('detail-crumb').textContent = title;

  const main = element('div', '', 'detail-main');
  const flags = element('div', '', 'detail-paper-flags');
  flags.append(element('span', 'PubMed'));
  main.append(flags, element('h2', title));
  if (article.authors.length) main.append(element('p', article.authors.join(', '), 'detail-notice'));
  if (article.publicationTypes?.length) {
    const types = element('div', '', 'detail-keywords');
    for (const type of article.publicationTypes) types.append(element('span', type));
    main.append(types);
  }
  const abstract = element('section', '', 'detail-abstract');
  const header = element('div', '', 'detail-section-head');
  header.append(element('h3', '摘要'));
  abstract.append(header, element('p', article.abstractText ?? 'PubMed 未收录摘要。', 'abstract'));
  main.append(abstract);

  const aside = element('aside', '', 'detail-sidebar');
  const info = element('section', '', 'detail-info');
  const infoHeader = element('div', '', 'detail-info-head');
  infoHeader.append(element('h3', '文献信息'));
  const metadata = element('dl');
  for (const [label, value] of [['期刊', article.journal], ['发表日期', article.publicationDate],
    ['PMID', article.pmid], ['DOI', article.doi]]) {
    const row = element('div');
    row.append(element('dt', label), element('dd', value ?? '未收录'));
    metadata.append(row);
  }
  const original = pubmed(article.pmid, '打开 PubMed 原文 ↗');
  original.className = 'detail-original';
  const select = element('button', '', 'detail-secondary');
  select.type = 'button';
  const syncSelection = () => {
    select.textContent = selected.has(article.pmid) ? '取消选择' : '加入证据分析';
    select.disabled = reviewing;
  };
  const notice = element('p', '', 'detail-notice');
  notice.setAttribute('role', 'status');
  select.onclick = () => {
    if (!toggleSelection(article, !selected.has(article.pmid))) {
      notice.textContent = '每份综述最多选择 10 篇文献。';
      return;
    }
    notice.textContent = '';
    syncSelection();
    renderResults();
  };
  syncSelection();
  info.append(infoHeader, metadata, original, select, favoriteButton(article, notice, 'detail-secondary'), notice);
  aside.append(info);
  target.replaceChildren(main, aside);
}

function toggleSelection(article, checked) {
  if (reviewing || (checked && selected.size >= 10 && !selected.has(article.pmid))) return false;
  if (checked) selected.set(article.pmid, article);
  else selected.delete(article.pmid);
  renderSelected();
  return true;
}

function renderArticle(article) {
  const card = element('article', '', 'paper-item');
  const label = element('label', '', 'compare-check');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(article.pmid);
  checkbox.disabled = reviewing;
  checkbox.setAttribute('aria-label', '选入综述 ' + (article.title ?? article.pmid));
  checkbox.onchange = () => {
    if (!toggleSelection(article, checkbox.checked)) {
      checkbox.checked = selected.has(article.pmid);
      showNotice('每份综述最多选择 10 篇文献。');
    }
  };
  label.append(checkbox);

  const body = element('div', '', 'paper-item-body');
  const meta = element('div', '', 'paper-meta');
  meta.append(element('span', article.journal ?? 'PubMed', 'conference-tag'));
  for (const entry of [article.publicationDate, `PMID ${article.pmid}`].filter(Boolean)) meta.append(element('span', entry));
  const title = element('a', article.title ?? '标题未收录', 'paper-title');
  title.href = '#detail/' + article.pmid;
  body.append(meta, title);
  if (article.authors.length) body.append(element('p', article.authors.join(', '), 'paper-meta'));
  body.append(element('p', article.abstractText ?? 'PubMed 未提供此文献的摘要。', 'paper-abstract'));
  const tags = element('div', '', 'paper-tags');
  for (const type of article.publicationTypes ?? []) tags.append(element('span', type));
  const rank = rankings.get(article.pmid);
  if (rank) {
    tags.append(element('span', `PubMed #${rank.pubmedRank}`), element('span', `BM25 ${rank.bm25.toFixed(2)}`));
    if (rank.semanticScore !== null) tags.append(element('span', `模型相关性 ${rank.semanticScore}/100`));
    if (rank.reason) body.append(element('p', rank.reason, 'paper-notice'));
  }
  body.append(tags);
  if (article.abstractText) {
    const details = element('details');
    details.append(element('summary', '展开摘要'), element('p', article.abstractText));
    body.append(details);
  }
  const actions = element('div', '', 'paper-actions');
  const libraryNotice = element('span', '', 'detail-notice');
  libraryNotice.setAttribute('role', 'status');
  actions.append(pubmed(article.pmid, 'PubMed 原文 ↗'), favoriteButton(article, libraryNotice), libraryNotice);
  body.append(actions);
  card.append(label, body);
  return card;
}

function favoriteButton(article, notice, className = 'detail-back') {
  const button = element('button', '', className);
  button.type = 'button';
  const sync = () => {
    const saved = savedArticles().some(item => item.pmid === article.pmid);
    button.textContent = saved ? '取消收藏' : '收藏文献';
    button.setAttribute('aria-pressed', String(saved));
  };
  sync();
  button.onclick = () => {
    try {
      const saved = changeLibrary(article);
      sync();
      notice.textContent = saved ? '已保存到我的文献库。' : '已从我的文献库移除。';
      if (!byId('library').hidden) renderLibrary();
    } catch (error) {
      notice.textContent = error.message;
    }
  };
  return button;
}

function makeTable(headers) {
  const region = element('div', '', 'route-grid');
  region.tabIndex = 0;
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', headers.join('、'));
  const table = element('table', '', 'route-table');
  const heading = table.createTHead().insertRow();
  for (const label of headers) {
    const cell = element('th', label);
    cell.scope = 'col';
    heading.append(cell);
  }
  region.append(table);
  return { region, rows: table.createTBody() };
}

function renderLibrary() {
  const container = byId('library-results');
  const saved = savedArticles();
  byId('library-md').disabled = byId('library-bib').disabled = !saved.length;
  const filter = byId('library-filter').value.trim().toLocaleLowerCase();
  const visible = saved.filter(article => [article.title, article.journal, article.pmid, ...article.authors]
    .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(filter)));
  container.replaceChildren();
  if (!visible.length) {
    container.append(element('p', saved.length ? '没有符合筛选条件的收藏。' : '文献库还没有收藏。可在文献检索结果或详情页收藏。'));
    return;
  }
  const { region, rows } = makeTable(['文献', '期刊与日期', '来源', '操作']);
  for (const article of visible) {
    const row = rows.insertRow();
    const title = element('a', article.title ?? '标题未收录');
    title.href = '#detail/' + article.pmid + '/library';
    row.insertCell().append(title);
    row.insertCell().textContent = [article.journal, article.publicationDate].filter(Boolean).join(' · ') || '未收录';
    row.insertCell().append(pubmed(article.pmid));
    const actions = row.insertCell();
    actions.append(favoriteButton(article, byId('library-status')));
  }
  container.append(region);
}
byId('library-filter').oninput = renderLibrary;
byId('library-md').onclick = () => downloadText('MedEvidence-library.md', literatureMarkdown(savedArticles()), 'text/markdown');
byId('library-bib').onclick = () => downloadText('MedEvidence-library.bib', literatureBibtex(savedArticles()), 'application/x-bibtex');

function renderRanking() {
  const target = byId('ranking-results');
  target.replaceChildren();
  if (!articles.length) {
    target.append(element('p', '检索 PubMed 后，这里会列出当前候选文献的排序。'));
    return;
  }
  const { region, rows } = makeTable(['文献', 'PubMed 位置', 'BM25', 'AI 分数', '推荐理由']);
  const ordered = [...articles].sort((left, right) => semanticOrder
    ? semanticOrder.get(left.pmid) - semanticOrder.get(right.pmid)
    : rankings.get(right.pmid).bm25 - rankings.get(left.pmid).bm25);
  for (const article of ordered) {
    const score = rankings.get(article.pmid);
    const row = rows.insertRow();
    const title = element('a', article.title ?? `PMID ${article.pmid}`);
    title.href = '#detail/' + article.pmid;
    row.insertCell().append(title);
    row.insertCell().textContent = score.pubmedRank;
    row.insertCell().textContent = score.bm25.toFixed(2);
    row.insertCell().textContent = score.semanticScore == null ? '—' : score.semanticScore + '/100';
    row.insertCell().textContent = score.reason ?? (semanticOrder ? '未进入模型候选范围' : '尚未运行模型排序');
  }
  target.append(region);
}

function dateKey(article) {
  const parts = article.publicationDate?.match(/^(\d{4})(?:[ -]+([a-z]{3}|\d{1,2})(?:[ -]+(\d{1,2}))?)?/i);
  if (!parts) return 0;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = Number(parts[2]) || months.indexOf(parts[2]?.toLowerCase()) + 1;
  return Number(parts[1]) * 10000 + month * 100 + Number(parts[3] ?? 0);
}

function renderResults() {
  const filter = byId('filter').value.trim().toLowerCase();
  const visible = articles.filter(article => (!byId('abstract-only').checked || article.abstractText) &&
    [article.title, article.journal, article.pmid, ...article.authors]
      .some(field => field?.toLowerCase().includes(filter)));
  const sort = byId('sort').value;
  if (sort === 'year') visible.sort((a, b) => dateKey(b) - dateKey(a));
  if (sort === 'bm25') visible.sort((a, b) => rankings.get(b.pmid).bm25 - rankings.get(a.pmid).bm25);
  if (sort === 'pubmed') visible.sort((a, b) => rankings.get(a.pmid).pubmedRank - rankings.get(b.pmid).pubmedRank);
  if (sort === 'ai' && semanticOrder) visible.sort((a, b) => semanticOrder.get(a.pmid) - semanticOrder.get(b.pmid));
  results.replaceChildren(...visible.map(renderArticle));
  if (articles.length && !visible.length) results.append(element('p', '当前筛选条件下没有文献。', 'note'));
}

function setBusy() {
  const busy = searching || reviewing || reranking;
  for (const id of ['search-button', 'browse-search-button', 'apply-filters', 'reset-filters']) byId(id).disabled = busy;
  for (const button of document.querySelectorAll('.browse-example')) button.disabled = busy;
  byId('rerank').disabled = busy || !capabilities.semantic || !articles.length || Boolean(semanticOrder);
  byId('prev').disabled = busy || !pageResult || pageResult.page <= 1;
  byId('next').disabled = busy || !pageResult || pageResult.page * pageResult.limit >= pageResult.accessibleTotal;
  if (!byId('ranking').hidden) renderRanking();
  updateReviewButton();
  renderHistory();
}

function showNotice(message) {
  const notice = byId('ranking-notice');
  notice.textContent = message ?? '';
  notice.hidden = !message;
  byId('ranking-status').textContent = message ?? '';
}

function setLiteratureFeedback(state, message = '', retry) {
  const feedback = byId('literature-feedback');
  feedback.dataset.state = state;
  feedback.hidden = !message;
  byId('literature-feedback-text').textContent = message;
  const button = byId('literature-retry');
  button.hidden = !retry;
  button.onclick = retry ?? null;
  byId('literature-intro').hidden = Boolean(pageResult) || state === 'loading';
  byId('literature-results').setAttribute('aria-busy', String(state === 'loading'));
}

function showAppliedFilters(request) {
  const type = [...byId('publication-type').options].find(option => option.value === request.publicationType);
  const labels = [];
  if (request.publicationType && type) labels.push(type.textContent);
  if (request.fromYear != null) labels.push(`自 ${request.fromYear} 年`);
  if (request.toYear != null) labels.push(`至 ${request.toYear} 年`);
  labels.push(`每页 ${request.limit} 篇`);
  byId('applied-filters').textContent = labels.join(' · ');
}

async function loadPage(request, page, newSearch) {
  if (searching || reviewing || reranking) return;
  searching = true;
  setBusy();
  const changedQuestion = question !== request.query;
  const loadingMessage = pageResult ? '正在更新 PubMed 结果…' : '正在检索 PubMed…';
  setLiteratureFeedback('loading', loadingMessage);
  homeStatus.textContent = loadingMessage;
  try {
    const body = await api('/literature/search', { ...request, page }, 75000);
    pageResult = body.data;
    lastRequest = { ...request, englishQuery: pageResult.englishQuery };
    question = request.query;
    if (newSearch) {
      const id = JSON.stringify(lastRequest);
      remember('searches', { id, request: lastRequest, question, total: pageResult.total });
      renderHistory();
    }
    byId('browse-query').value = question;
    articles = pageResult.articles;
    rankings = new Map(pageResult.rankings.map(rank => [rank.pmid, rank]));
    semanticOrder = null;
    byId('sort').querySelector('[value=ai]').disabled = true;
    if (byId('sort').value === 'ai') byId('sort').value = 'bm25';
    if (changedQuestion) {
      selected.clear();
      currentReview = null;
      renderComparisonRoute();
      byId('export-review').hidden = true;
      reviewStatus.removeAttribute('data-state');
      reviewStatus.textContent = capabilities.review ? '' : '配置模型与 MySQL 后可生成证据综述。';
      byId('review-result').replaceChildren();
      byId('filter').value = '';
      byId('abstract-only').checked = false;
      byId('sort').value = 'bm25';
    }
    byId('literature-facets').hidden = false;
    byId('literature-results').hidden = false;
    showAppliedFilters(lastRequest);
    byId('filters').hidden = !articles.length;
    byId('local-filters').hidden = !articles.length;
    const expression = byId('expression');
    expression.querySelector('p').textContent = pageResult.pubmedQuery;
    expression.hidden = false;
    showNotice(pageResult.rankingNotice);
    status.textContent = articles.length
      ? `匹配 ${pageResult.total.toLocaleString()} 篇 · 本页 ${articles.length} 篇`
      : '本页无文献';
    setLiteratureFeedback(articles.length ? 'success' : 'empty',
      articles.length ? '' : 'PubMed 没有返回本页文献。可放宽筛选条件或修改检索问题。');
    const pageCount = Math.max(1, Math.ceil(pageResult.accessibleTotal / pageResult.limit));
    byId('pagination').hidden = pageCount <= 1 && pageResult.page <= 1;
    byId('page-label').textContent = `第 ${pageResult.page} / ${pageCount} 页`;
    renderSelected();
    renderResults();
    homeStatus.textContent = '';
    if (newSearch && window.location.hash !== '#literature') window.location.hash = 'literature';
  } catch (error) {
    const message = error.message + (pageResult ? ' 仍保留上一次检索结果和选择。' : '');
    setLiteratureFeedback('error', message, error.code === 'ENGLISH_QUERY_REQUIRED' ? null
      : () => loadPage(request, page, newSearch));
    homeStatus.textContent = message;
    if (error.code === 'ENGLISH_QUERY_REQUIRED') {
      byId('query').value = request.query;
      byId('english-options').open = true;
      window.location.hash = 'question';
      syncNavigation();
      byId('english').focus();
    }
  } finally {
    searching = false;
    renderSelected();
    setBusy();
  }
}

function optionalYear(id) {
  return byId(id).value === '' ? undefined : Number(byId(id).value);
}

function searchFilters() {
  return {
    limit: Number(byId('page-size').value),
    fromYear: optionalYear('from-year'),
    toYear: optionalYear('to-year'),
    publicationType: byId('publication-type').value,
  };
}

form.onsubmit = event => {
  event.preventDefault();
  loadPage({
    ...searchFilters(),
    query: byId('query').value.trim(),
    englishQuery: byId('english').value.trim(),
  }, 1, true);
};

function submitQuickSearch(input) {
  const query = input.value.trim();
  if (!query) return;
  byId('query').value = query;
  byId('english').value = '';
  loadPage({ ...searchFilters(), query, englishQuery: '' }, 1, true);
}

byId('global-search').onsubmit = event => {
  event.preventDefault();
  submitQuickSearch(byId('global-query'));
};
for (const example of document.querySelectorAll('.browse-example')) {
  example.onclick = () => {
    const input = byId('browse-query');
    input.value = example.textContent.trim();
    submitQuickSearch(input);
  };
}
byId('browse-search').onsubmit = event => {
  event.preventDefault();
  submitQuickSearch(byId('browse-query'));
};
byId('reset-filters').onclick = () => {
  for (const id of ['from-year', 'to-year', 'publication-type', 'filter']) byId(id).value = '';
  byId('page-size').value = '10';
  byId('abstract-only').checked = false;
  byId('sort').value = 'bm25';
  if (lastRequest) loadPage({ ...lastRequest, ...searchFilters() }, 1, true);
};

byId('apply-filters').onclick = () => {
  if (!lastRequest) {
    window.location.hash = 'question';
    byId('query').focus();
    return;
  }
  const yearInputs = [byId('from-year'), byId('to-year')];
  if (yearInputs.some(input => !input.reportValidity())) return;
  loadPage({ ...lastRequest, ...searchFilters() }, 1, true);
};

byId('prev').onclick = () => loadPage(lastRequest, pageResult.page - 1, false);
byId('next').onclick = () => loadPage(lastRequest, pageResult.page + 1, false);
function clearSelection() {
  if (reviewing || searching) return;
  selected.clear();
  renderSelected();
  renderResults();
}
byId('clear-selection').onclick = clearSelection;
byId('clear-literature-selection').onclick = clearSelection;
byId('edit-expression').onclick = () => {
  byId('english').value = pageResult.englishQuery;
  byId('english-options').open = true;
  window.location.hash = 'question';
  syncNavigation();
  byId('english').focus();
};
for (const example of document.querySelectorAll('.example')) {
  example.onclick = () => {
    byId('query').value = example.dataset.query;
    byId('english').value = '';
    byId('query').focus();
  };
}

byId('rerank').onclick = async () => {
  if (reranking || searching || reviewing || !capabilities.semantic || semanticOrder || !articles.length) return;
  reranking = true;
  setBusy();
  showNotice('正在重排本页候选文献…');
  try {
    const ids = articles.map(article => article.pmid).sort((a, b) => rankings.get(a).pubmedRank - rankings.get(b).pubmedRank);
    const response = await api('/literature/rerank', {
      question, englishQuery: lastRequest.englishQuery, pmids: ids,
    }, 65000);
    semanticOrder = new Map(response.data.map((rank, index) => [rank.pmid, index]));
    for (const rank of response.data) rankings.set(rank.pmid, { ...rank, pubmedRank: rankings.get(rank.pmid).pubmedRank });
    byId('sort').querySelector('[value=ai]').disabled = false;
    byId('sort').value = 'ai';
    showNotice('AI 相关性分值仅用于排序，BM25 分值仅可在本页比较。');
    renderResults();
  } catch (error) {
    byId('sort').value = 'bm25';
    showNotice(error.message + ' 已保留 BM25 排序。');
    renderResults();
  } finally {
    reranking = false;
    setBusy();
  }
};

const taskLabels = { PENDING: '排队中', RUNNING: '分析中', SUCCESS: '已完成', FAILED: '失败', TIMED_OUT: '已超时' };

function historyTime(item) {
  return new Date(item.at).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

function restoreSearch(item) {
  const request = item.request;
  byId('query').value = request.query;
  byId('english').value = request.englishQuery ?? '';
  byId('from-year').value = request.fromYear ?? '';
  byId('to-year').value = request.toYear ?? '';
  byId('publication-type').value = request.publicationType ?? '';
  byId('page-size').value = request.limit ?? 10;
  if (lastRequest && JSON.stringify(lastRequest) === JSON.stringify(request)) {
    window.location.hash = 'literature';
  } else {
    loadPage(request, 1, true);
  }
}

function renderHistory() {
  const busy = searching || reviewing || reranking;
  for (const [kind, empty] of [['searches', '成功检索后，可在这里重新运行。'], ['tasks', '提交证据分析后，可在这里重新打开任务。']]) {
    const list = byId('recent-' + kind);
    const entries = recent(kind);
    byId('clear-' + kind).hidden = !entries.length;
    const task = kind === 'tasks';
    const actionLabel = task ? '查看任务' : '恢复查询';
    const actionFor = item => task ? reopenTask(item) : restoreSearch(item);
    const details = item => task ? taskLabels[item.state] ?? '未知状态' : `${item.total.toLocaleString()} 篇`;
    list.replaceChildren();
    if (!entries.length) list.append(element('li', empty, 'recent-empty'));
    const page = byId(task ? 'tasks-content' : 'history-content');
    page.replaceChildren();
    if (!entries.length) {
      page.append(element('p', empty));
      continue;
    }
    const tools = element('div', '', 'route-toolbar');
    const clear = element('button', '清空本地记录', 'detail-back');
    clear.type = 'button';
    clear.disabled = busy;
    clear.onclick = () => { clearRecent(kind); renderHistory(); };
    tools.append(clear);
    const { region, rows } = makeTable([task ? '研究问题' : '检索问题', task ? '状态' : '匹配结果', '时间', '操作']);
    for (const item of entries) {
      const row = element('li');
      const action = element('button', '', 'recent-paper');
      action.type = 'button';
      action.disabled = busy;
      action.append(element('span', item.question), element('small', details(item) + ' · ' + historyTime(item)));
      action.onclick = () => actionFor(item);
      row.append(action);
      list.append(row);

      const tableRow = rows.insertRow();
      tableRow.insertCell().textContent = item.question;
      tableRow.insertCell().textContent = details(item);
      tableRow.insertCell().textContent = historyTime(item);
      const actions = tableRow.insertCell();
      actions.className = 'actions';
      const open = element('button', actionLabel, 'detail-back');
      open.type = 'button';
      open.disabled = busy;
      open.onclick = () => actionFor(item);
      actions.append(open);
      if (task) {
        const refresh = element('button', '更新状态', 'detail-back');
        refresh.type = 'button';
        refresh.disabled = busy;
        refresh.onclick = async () => {
          refresh.disabled = true;
          try {
            recordTask((await api('/reviews/' + item.id)).data, item.question);
          } catch (error) {
            actions.append(element('span', error.message, 'detail-notice'));
            refresh.disabled = false;
          }
        };
        actions.append(refresh);
      }
    }
    page.append(tools, region);
  }
}

for (const kind of ['searches', 'tasks']) {
  byId('clear-' + kind).onclick = () => {
    clearRecent(kind);
    renderHistory();
  };
}

function recordTask(task, topic) {
  remember('tasks', { id: task.id, question: task.question ?? topic, state: task.state,
    at: Date.parse(task.createdAt) || undefined });
  renderHistory();
}

async function reopenTask(item) {
  if (searching || reviewing || reranking) return;
  window.location.hash = 'review';
  await runReview(async () => (await api('/reviews/' + item.id)).data, item.question, '正在读取任务…');
}

const reviewSections = [['主要发现', 'findings'], ['一致性', 'agreement'], ['分歧', 'differences'],
  ['研究局限', 'limitations'], ['综合结论', 'conclusion']];
const evidenceFields = [['研究对象', 'population'], ['研究目的', 'objective'], ['研究方法', 'studyDesign'],
  ['主要发现', 'finding'], ['研究局限', 'limitation']];

function inReviewLink(label, target, open = false) {
  const link = element('a', label, 'citation-link');
  link.href = '#' + target;
  link.onclick = event => {
    event.preventDefault();
    const section = byId(target);
    if (!section) return;
    if (open) section.open = true;
    const focus = open ? section.querySelector('summary') : section;
    focus.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  };
  return link;
}

function renderComparison(evidence, references, standalone = false) {
  const section = element('section', '', 'compare-page review-section');
  section.id = standalone ? 'comparison-table' : 'review-comparison';
  section.tabIndex = -1;
  const toolbar = element('header', '', 'compare-toolbar');
  const heading = element('div');
  heading.append(element('strong', '结构化证据对比'), element('span', `${evidence.length} 篇有摘要文献`));
  toolbar.append(heading);
  section.append(toolbar);
  if (!evidence.length) {
    section.append(element('p', '当前任务没有可比较的结构化证据。', 'compare-notice'));
    return section;
  }
  const scroller = element('div', '', 'compare-region');
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', '证据对比表，可横向滚动');
  const table = element('table', '', 'evidence-table');
  const caption = element('caption', '按文献比较结构化摘要证据', 'visually-hidden');
  const header = table.createTHead().insertRow();
  const field = element('th', '比较维度');
  field.scope = 'col';
  header.append(field);
  for (const item of evidence) {
    const column = element('th');
    column.scope = 'col';
    const reference = references.get(item.pmid);
    const link = standalone ? element('a', 'PMID ' + item.pmid) : inReviewLink('PMID ' + item.pmid, 'evidence-' + item.pmid, true);
    if (standalone) {
      link.href = '#review';
      link.onclick = event => {
        event.preventDefault();
        window.location.hash = 'review';
        syncNavigation();
        requestAnimationFrame(() => {
          const evidenceSource = byId('evidence-' + item.pmid);
          if (!evidenceSource) return;
          evidenceSource.open = true;
          evidenceSource.querySelector('summary')?.focus({ preventScroll: true });
          evidenceSource.scrollIntoView({ block: 'start' });
        });
      };
    }
    column.append(link);
    if (reference?.title) column.append(element('small', reference.title));
    header.append(column);
  }
  const body = table.createTBody();
  for (const [label, key] of evidenceFields) {
    const row = body.insertRow();
    const rowHeader = element('th', label);
    rowHeader.scope = 'row';
    row.append(rowHeader);
    for (const item of evidence) row.insertCell().textContent = item[key] ?? '摘要未提供';
  }
  table.prepend(caption);
  scroller.append(table);
  section.append(scroller);
  return section;
}

function renderComparisonRoute() {
  const target = byId('comparison-content');
  target.replaceChildren();
  if (!currentReview) {
    target.append(element('p', '先生成综述或打开已完成的分析任务，这里会显示逐篇证据。'));
    for (const [hash, label] of [['review', '打开 AI 证据综述'], ['tasks', '查看分析任务']]) {
      const link = element('a', label, 'detail-back');
      link.href = '#' + hash;
      target.append(link, ' ');
    }
    return;
  }
  if (currentReview.question) target.append(element('h2', currentReview.question, 'review-topic'));
  const references = new Map((currentReview.references ?? []).map(article => [article.pmid, article]));
  target.append(renderComparison(currentReview.evidence ?? [], references, true));
}

function renderReview(review, topic) {
  const target = byId('review-result');
  target.replaceChildren();
  const evidence = review.evidence ?? [];
  const references = new Map((review.references ?? []).map(article => [article.pmid, article]));
  const evidenceIds = new Set(evidence.map(item => item.pmid));
  target.append(element('h2', review.question ?? topic, 'review-topic'));
  const outline = element('nav', '', 'review-outline');
  outline.setAttribute('aria-label', '证据综述章节');
  outline.append(inReviewLink('证据对比', 'review-comparison'));
  for (const [label, key] of reviewSections) outline.append(inReviewLink(label, 'review-' + key));
  target.append(outline, renderComparison(evidence, references));
  for (const [label, key] of reviewSections) {
    const group = element('section', '', 'detail-abstract review-section');
    group.id = 'review-' + key;
    group.tabIndex = -1;
    const header = element('div', '', 'detail-section-head');
    header.append(element('h3', label));
    group.append(header);
    if (!review[key]?.length) group.append(element('p', '所选摘要未提供足够证据。', 'note'));
    else {
      const list = element('ul');
      for (const point of review[key]) {
        const item = element('li', point.text + ' ');
        for (const id of point.pmids) {
          const citationLink = evidenceIds.has(id) ? inReviewLink(`[PMID ${id}]`, 'evidence-' + id, true) : pubmed(id);
          item.append(citationLink, ' ');
        }
        list.append(item);
      }
      group.append(list);
    }
    target.append(group);
  }
  if (review.missingAbstractPmids?.length) {
    const missing = element('p', '以下文献因缺少摘要未纳入综述 ', 'note');
    for (const id of review.missingAbstractPmids) missing.append(pubmed(id), ' ');
    target.append(missing);
  }
  const sources = element('section', '', 'detail-abstract');
  sources.append(element('h3', '逐篇证据与摘要原文'));
  for (const item of evidence) {
    const group = element('details', '', 'evidence-source review-section');
    group.id = 'evidence-' + item.pmid;
    const reference = references.get(item.pmid);
    group.append(element('summary', `PMID ${item.pmid}` + (reference?.title ? ' · ' + reference.title : '')),
      pubmed(item.pmid, '查看 PubMed 原文 ↗'));
    for (const [label, key] of [...evidenceFields, ['模型解读', 'interpretation']]) {
      group.append(element('p', label + ' · ' + (item[key] ?? '摘要未提供')));
    }
    if (item.quote) group.append(element('blockquote', item.quote, 'evidence-quote'));
    if (reference?.abstractText) {
      const original = element('details');
      original.append(element('summary', '查看 PubMed 摘要'), element('p', reference.abstractText, 'abstract'));
      group.append(original);
    }
    sources.append(group);
  }
  if (evidence.length) target.append(sources);
}

async function followReview(task, topic) {
  let recordedState;
  const deadline = Date.now() + 165000;
  while (task.state === 'PENDING' || task.state === 'RUNNING') {
    if (recordedState !== task.state) {
      recordTask(task, topic);
      recordedState = task.state;
    }
    reviewStatus.dataset.state = task.state;
    reviewStatus.textContent = task.state === 'PENDING' ? '任务已排队…' : '正在提取并综合摘要证据…';
    if (Date.now() >= deadline) throw new Error('等待任务状态超时。再次提交同一选题可查询原任务。');
    await new Promise(resolve => setTimeout(resolve, 2000));
    task = (await api('/reviews/' + task.id)).data;
  }
  recordTask(task, topic);
  reviewStatus.dataset.state = task.state;
  if (task.state !== 'SUCCESS') throw new Error(task.message ?? '综述任务失败。');
  currentReview = task.result;
  renderReview(currentReview, topic);
  renderComparisonRoute();
  byId('export-review').hidden = false;
  reviewStatus.textContent = '综述已生成，待人工核查。';
}

async function runReview(start, topic, initialStatus) {
  reviewing = true;
  setBusy();
  currentReview = null;
  renderComparisonRoute();
  byId('export-review').hidden = true;
  reviewStatus.dataset.state = 'PENDING';
  reviewStatus.textContent = initialStatus;
  byId('review-result').replaceChildren();
  renderSelected();
  renderResults();
  try {
    await followReview(await start(), topic);
  } catch (error) {
    if (reviewStatus.dataset.state !== 'TIMED_OUT') reviewStatus.dataset.state = 'FAILED';
    reviewStatus.textContent = error.message;
  } finally {
    reviewing = false;
    setBusy();
    renderSelected();
    renderResults();
  }
}

byId('review-button').onclick = () => {
  if (reviewing || searching || reranking || !selected.size || !capabilities.review) return;
  const request = { question, pmids: [...selected.keys()] };
  runReview(async () => (await api('/reviews', request)).data, question, '正在提交任务…');
};

byId('export-literature-md').onclick = () => {
  if (selected.size) downloadText('MedEvidence-literature.md', literatureMarkdown([...selected.values()]), 'text/markdown');
};
byId('export-literature-bib').onclick = () => {
  if (selected.size) downloadText('MedEvidence-literature.bib', literatureBibtex([...selected.values()]), 'application/x-bibtex');
};

byId('filter').oninput = renderResults;
byId('sort').onchange = renderResults;
byId('abstract-only').onchange = renderResults;

function setServiceCard(service, state, label, message) {
  const indicator = byId(service + '-card-status');
  indicator.dataset.state = state;
  indicator.textContent = label;
  const content = byId(service + '-card-message');
  const parts = message.split(/((?:AI|REVIEW_DB)_[A-Z_]+)/);
  content.replaceChildren(...parts.map((part, index) => index % 2 ? element('code', part) : part));
}

async function refreshCapabilities() {
  try {
    capabilities = (await api('/capabilities')).data;
    byId('model-state').textContent = capabilities.semantic ? '' : '模型未配置';
    if (!capabilities.review && !reviewing && !currentReview) {
      reviewStatus.textContent = '需要配置模型与 MySQL 才能生成综述。';
    }
  } catch {
    capabilities = { semantic: false, review: false };
    byId('model-state').textContent = '无法读取后端配置';
  }
  setBusy();
}

let checkingModel = false;
let checkingSettings = false;
let loadedSettings = false;
let modelConfigured = false;

function setModelButtons() {
  byId('refresh-model-settings').disabled = checkingSettings || checkingModel;
  byId('test-model').disabled = checkingSettings || checkingModel || !modelConfigured;
}

async function refreshModelSettings() {
  if (checkingSettings || checkingModel) return;
  checkingSettings = true;
  setModelButtons();
  byId('model-connection').hidden = true;
  setServiceCard('model', 'unknown', '检查中', '正在读取后端配置…');
  setServiceCard('database', 'unknown', '检查中', '正在读取连接和任务表状态…');
  try {
    const { data } = await api('/models/status');
    modelConfigured = data.modelConfigured;
    loadedSettings = true;
    setServiceCard('model', modelConfigured ? 'configured' : 'unconfigured',
      modelConfigured ? '已配置 · 待测试' : '未配置',
      modelConfigured ? '配置项齐全。点击测试可验证模型服务是否响应。'
        : `请在后端设置 ${data.missingModelSettings.join('、')}。`);
    const database = data.database;
    const labels = { CONNECTED: '连接正常', UNCONFIGURED: '未配置', ERROR: '检查失败' };
    setServiceCard('database', database.state.toLowerCase(), labels[database.state], database.message);
  } catch (error) {
    modelConfigured = false;
    loadedSettings = false;
    const guidance = error.code === 'LOCAL_REVIEW_ONLY'
      ? '请在运行后端的机器上通过本机地址打开此页面。'
      : '请确认后端已启动且浏览器可访问，然后刷新状态。';
    const message = error.message + ' ' + guidance;
    setServiceCard('model', 'error', '状态不可用', message);
    setServiceCard('database', 'error', '状态不可用', message);
  } finally {
    checkingSettings = false;
    setModelButtons();
  }
}

byId('refresh-model-settings').onclick = () => {
  refreshModelSettings();
  refreshCapabilities();
};
byId('test-model').onclick = async () => {
  if (checkingModel || checkingSettings || !modelConfigured) return;
  checkingModel = true;
  setModelButtons();
  const result = byId('model-connection');
  result.hidden = true;
  setServiceCard('model', 'unknown', '测试中', '正在向配置的模型发起一次验证请求…');
  try {
    const response = await api('/models/connection-test', {}, 65000);
    setServiceCard('model', 'connected', '连接正常', '本次测试已收到有效的模型响应。');
    result.dataset.state = 'connected';
    result.textContent = response.message;
  } catch (error) {
    setServiceCard('model', 'error', '测试失败', '模型配置项已填写，当前连接未通过验证。');
    result.dataset.state = 'error';
    result.textContent = error.message + (error.code ? '' : ' 请确认后端与模型服务均可访问。');
  } finally {
    result.hidden = false;
    checkingModel = false;
    setModelButtons();
  }
};

byId('export-review').onclick = () => {
  if (!currentReview) return;
  const output = ['# MedEvidence 证据综述', '',
    '> AI 生成 · 待人工核查。请逐条核对 PubMed 摘要。仅用于医学研究信息辅助，不用于个体诊疗。', '',
    '## 研究问题', '', markdownText(currentReview.question ?? question)];
  for (const [label, key] of reviewSections) {
    output.push('', '## ' + label, '');
    const points = currentReview[key] ?? [];
    if (!points.length) output.push('所选摘要未提供足够证据。');
    for (const point of points) output.push('- ' + markdownText(point.text) + ' ' + point.pmids.map(citation).join(' · '));
  }
  output.push('', '## 引用文献', '');
  const references = new Map((currentReview.references ?? []).map(article => [article.pmid, article]));
  const cited = new Set(['findings','agreement','differences','limitations','conclusion']
    .flatMap(key => (currentReview[key] ?? []).flatMap(point => point.pmids)));
  for (const id of cited) {
    const article = references.get(id);
    const details = [article?.title, article?.journal, article?.publicationDate, article?.doi].filter(Boolean);
    output.push('- ' + citation(id) + (details.length ? ' · ' + details.map(markdownText).join(' · ') : ''));
  }
  downloadText('MedEvidence-review.md', output.join('\n') + '\n', 'text/markdown');
};

function syncNavigation() {
  const pages = ['question', 'literature', 'library', 'history', 'ranking', 'comparison', 'review', 'tasks', 'models', 'detail'];
  const [section, pmid, parentRoute] = window.location.hash.slice(1).split('/');
  const detailParent = parentRoute === 'library' ? 'library' : 'literature';
  const active = pages.includes(section) ? section : 'question';
  for (const id of pages) byId(id === 'models' ? 'models-view' : id).hidden = id !== active;
  byId('global-search').hidden = active === 'question' || active === 'literature';
  byId('workspace-label').hidden = !byId('global-search').hidden;
  if (active === 'detail') {
    byId('detail-return').href = '#' + detailParent;
    byId('detail-parent').href = '#' + detailParent;
    byId('detail-parent').textContent = detailParent === 'library' ? '我的文献库' : '文献检索';
    const article = articles.find(item => item.pmid === pmid) ?? selected.get(pmid) ?? savedArticles().find(item => item.pmid === pmid);
    if (article) renderPaperDetail(article);
    else {
      byId('detail-crumb').textContent = '';
      byId('paper-detail-content').replaceChildren(element('p', '请返回文献列表重新查找该记录。', 'detail-missing'));
    }
  }
  const rerankTarget = byId(active === 'ranking' ? 'ranking-action' : 'local-filters');
  if (byId('rerank').parentElement !== rerankTarget) rerankTarget.append(byId('rerank'));
  if (active === 'library') renderLibrary();
  if (active === 'models' && !loadedSettings) refreshModelSettings();
  if (active === 'literature') renderResults();
  if (active === 'ranking') renderRanking();
  if (active === 'comparison') renderComparisonRoute();
  if (active === 'history' || active === 'tasks') renderHistory();
  for (const link of document.querySelectorAll('.nav-list a')) {
    const matches = link.getAttribute('href') === '#' + (active === 'detail' ? detailParent : active);
    link.classList.toggle('active', matches);
    if (matches) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
const menu = byId('toggle-navigation');
const navigation = byId('workspace-navigation');
function setMenu(open) {
  navigation.toggleAttribute('data-open', open);
  menu.setAttribute('aria-expanded', String(open));
}
menu.onclick = () => setMenu(!navigation.hasAttribute('data-open'));
navigation.addEventListener('click', event => {
  if (event.target.closest('.nav-link') && navigation.hasAttribute('data-open')) {
    setMenu(false);
    menu.focus();
  }
});
navigation.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation.hasAttribute('data-open')) {
    setMenu(false);
    menu.focus();
  }
});

window.addEventListener('hashchange', () => {
  syncNavigation();
  window.scrollTo({ top: 0, behavior: 'instant' });
});
syncNavigation();

renderHistory();

await refreshCapabilities();
