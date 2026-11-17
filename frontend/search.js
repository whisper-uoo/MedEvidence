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
  byId('selection-count').textContent = `已选 ${selected.size} / 10 篇`;
  for (const article of selected.values()) {
    const line = element('div');
    const remove = element('button', '移除', 'secondary');
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

function openPaper(article) {
  const target = byId('paper-detail-content');
  const heading = element('h2', article.title ?? '标题未收录');
  heading.id = 'paper-detail-title';
  const metadata = [article.journal, article.publicationDate, `PMID ${article.pmid}`,
    article.doi && `DOI ${article.doi}`].filter(Boolean).join(' · ');
  target.replaceChildren(heading, element('p', metadata, 'meta'));
  if (article.authors.length) target.append(element('p', article.authors.join(', '), 'meta'));
  target.append(pubmed(article.pmid, '查看 PubMed 原文 ↗'), element('h3', '摘要'),
    element('p', article.abstractText ?? 'PubMed 未收录摘要。', 'abstract'));
  byId('paper-detail').showModal();
}

function renderArticle(article) {
  const card = element('article');
  const head = element('div', '', 'article-head');
  const title = element('h3');
  const detailButton = element('button', article.title ?? '标题未收录', 'paper-title');
  detailButton.type = 'button';
  detailButton.onclick = () => openPaper(article);
  title.append(detailButton);
  const label = element('label', '', 'toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(article.pmid);
  checkbox.disabled = reviewing;
  checkbox.setAttribute('aria-label', '选入综述 ' + (article.title ?? article.pmid));
  checkbox.onchange = () => {
    if (checkbox.checked && selected.size >= 10) {
      checkbox.checked = false;
      reviewStatus.textContent = '每份综述最多选择 10 篇文献。';
      return;
    }
    if (checkbox.checked) selected.set(article.pmid, article);
    else selected.delete(article.pmid);
    renderSelected();
  };
  label.append(checkbox, '选择');
  head.append(title, label);
  const identity = [article.journal, article.publicationDate, `PMID ${article.pmid}`,
    article.doi && `DOI ${article.doi}`].filter(Boolean).join(' · ');
  card.append(head, element('p', identity, 'meta'));
  if (article.publicationTypes?.length) card.append(element('p', article.publicationTypes.join(' · '), 'meta'));
  if (article.authors.length) card.append(element('p', article.authors.join(', '), 'meta'));
  const rank = rankings.get(article.pmid);
  if (rank) {
    const scores = [`PubMed #${rank.pubmedRank}`, `BM25 ${rank.bm25.toFixed(2)}`];
    if (rank.semanticScore !== null) scores.push(`模型相关性 ${rank.semanticScore}/100`);
    card.append(element('p', scores.join(' · '), 'meta'));
    if (rank.reason) card.append(element('p', rank.reason, 'reason'));
  }
  if (article.abstractText) card.append(element('p', article.abstractText.slice(0, 420), 'preview'));
  const details = element('details');
  details.append(element('summary', article.abstractText ? '展开摘要' : '摘要未收录'),
    element('p', article.abstractText ?? 'PubMed 未提供此文献的摘要。', 'abstract'));
  card.append(details, pubmed(article.pmid, `PubMed · ${article.pmid} ↗`));
  return card;
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
  for (const id of ['search-button', 'apply-filters']) byId(id).disabled = busy;
  byId('rerank').disabled = busy || !capabilities.semantic || !articles.length || Boolean(semanticOrder);
  byId('prev').disabled = busy || !pageResult || pageResult.page <= 1;
  byId('next').disabled = busy || !pageResult || pageResult.page * pageResult.limit >= pageResult.accessibleTotal;
  updateReviewButton();
}

function showNotice(message) {
  const notice = byId('ranking-notice');
  notice.textContent = message ?? '';
  notice.hidden = !message;
}

async function loadPage(request, page, newSearch) {
  if (searching || reviewing || reranking) return;
  searching = true;
  setBusy();
  status.textContent = '正在检索 PubMed…';
  homeStatus.textContent = status.textContent;
  try {
    const body = await api('/literature/search', { ...request, page }, 75000);
    pageResult = body.data;
    lastRequest = { ...request, englishQuery: pageResult.englishQuery };
    question = request.query;
    byId('active-question').textContent = question;
    articles = pageResult.articles;
    rankings = new Map(pageResult.rankings.map(rank => [rank.pmid, rank]));
    semanticOrder = null;
    byId('sort').querySelector('[value=ai]').disabled = true;
    if (byId('sort').value === 'ai') byId('sort').value = 'bm25';
    if (newSearch) {
      selected.clear();
      currentReview = null;
      byId('export-review').hidden = true;
      reviewStatus.textContent = capabilities.review ? '' : '配置模型与 MySQL 后可生成证据综述。';
      byId('review-result').replaceChildren();
      byId('filter').value = '';
      byId('abstract-only').checked = false;
      byId('sort').value = 'bm25';
    }
    byId('filters').hidden = !articles.length;
    const expression = byId('expression');
    expression.querySelector('p').textContent = pageResult.pubmedQuery;
    expression.hidden = false;
    showNotice(pageResult.rankingNotice);
    status.textContent = articles.length
      ? `匹配 ${pageResult.total.toLocaleString()} 篇 · 本页 ${articles.length} 篇`
      : body.message;
    const pageCount = Math.max(1, Math.ceil(pageResult.accessibleTotal / pageResult.limit));
    byId('pagination').hidden = pageCount <= 1 && pageResult.page <= 1;
    byId('page-label').textContent = `第 ${pageResult.page} / ${pageCount} 页`;
    renderSelected();
    renderResults();
    homeStatus.textContent = '';
    if (newSearch && window.location.hash !== '#literature') window.location.hash = 'literature';
  } catch (error) {
    status.textContent = error.message + (articles.length ? ' 仍显示上一次检索结果。' : '');
    homeStatus.textContent = status.textContent;
    if (error.code === 'ENGLISH_QUERY_REQUIRED') {
      byId('english-options').open = true;
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
byId('clear-selection').onclick = () => { selected.clear(); renderSelected(); renderResults(); };
byId('edit-expression').onclick = () => {
  byId('english').value = pageResult.englishQuery;
  byId('english-options').open = true;
  window.location.hash = 'question';
  syncNavigation();
  byId('english').focus();
};
for (const example of document.querySelectorAll('.example')) {
  example.onclick = () => {
    byId('query').value = example.textContent.trim();
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

function renderReview(review) {
  const target = byId('review-result');
  target.replaceChildren();
  target.append(element('h3', '研究问题'), element('p', review.question ?? question));
  for (const [label, key] of [['主要发现', 'findings'], ['一致性', 'agreement'], ['分歧', 'differences'],
    ['研究局限', 'limitations'], ['综合结论', 'conclusion']]) {
    const group = element('section');
    group.append(element('h3', label));
    if (!review[key]?.length) group.append(element('p', '所选摘要未提供足够证据。', 'note'));
    else {
      const list = element('ul');
      for (const point of review[key]) {
        const item = element('li', point.text + ' ');
        for (const id of point.pmids) item.append(pubmed(id, `[${id}]`), ' ');
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
  const extracts = element('details');
  extracts.append(element('summary', '逐篇证据与摘要原文'));
  for (const item of review.evidence) {
    const group = element('section');
    const reference = review.references?.find(source => source.pmid === item.pmid);
    group.append(pubmed(item.pmid, reference?.title ?? `PMID ${item.pmid}`));
    for (const [label, key] of [['研究对象','population'], ['目的','objective'], ['方法','studyDesign'],
      ['作者报告的发现','finding'], ['局限','limitation'], ['模型解读','interpretation']]) {
      group.append(element('p', label + ' · ' + (item[key] ?? '摘要未提供')));
    }
    group.append(element('blockquote', item.quote));
    if (reference?.abstractText) {
      const original = element('details');
      original.append(element('summary', '查看 PubMed 摘要'), element('p', reference.abstractText, 'abstract'));
      group.append(original);
    }
    extracts.append(group);
  }
  target.append(extracts);
}

async function followReview(task) {
  const deadline = Date.now() + 165000;
  while (task.state === 'PENDING' || task.state === 'RUNNING') {
    reviewStatus.textContent = task.state === 'PENDING' ? '任务已排队…' : '正在提取并综合摘要证据…';
    if (Date.now() >= deadline) throw new Error('等待任务状态超时。再次提交同一选题可查询原任务。');
    await new Promise(resolve => setTimeout(resolve, 2000));
    task = (await api('/reviews/' + task.id)).data;
  }
  if (task.state !== 'SUCCESS') throw new Error(task.message ?? '综述任务失败。');
  currentReview = task.result;
  renderReview(currentReview);
  byId('export-review').hidden = false;
  reviewStatus.textContent = '综述已生成。';
}

byId('review-button').onclick = async () => {
  if (reviewing || searching || reranking || !selected.size) return;
  reviewing = true;
  setBusy();
  currentReview = null;
  byId('export-review').hidden = true;
  reviewStatus.textContent = '正在提交任务…';
  byId('review-result').replaceChildren();
  renderSelected();
  renderResults();
  try {
    const response = await api('/reviews', { question, pmids: [...selected.keys()] });
    await followReview(response.data);
  } catch (error) {
    reviewStatus.textContent = error.message;
  } finally {
    reviewing = false;
    setBusy();
    renderSelected();
    renderResults();
  }
};

byId('filter').oninput = renderResults;
byId('sort').onchange = renderResults;
byId('abstract-only').onchange = renderResults;

try {
  capabilities = (await api('/capabilities')).data;
  setBusy();
  byId('model-state').textContent = capabilities.semantic ? '' : '模型未配置';
  if (!capabilities.review) reviewStatus.textContent = '需要配置模型与 MySQL 才能生成综述。';
} catch {
  byId('model-state').textContent = '无法读取后端配置';
}

function markdownText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, character => '\\' + character);
}

byId('export-review').onclick = () => {
  if (!currentReview) return;
  const output = ['# MedEvidence 证据综述', '',
    '> AI 生成，仅用于医学研究信息辅助。请核对 PubMed 原文；不用于个体诊疗。', '',
    '## 研究问题', '', markdownText(currentReview.question ?? question)];
  const citation = id => `[PMID ${id}](https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(id)}/)`;
  for (const [label, key] of [['主要发现','findings'], ['一致性','agreement'], ['分歧','differences'],
    ['研究局限','limitations'], ['综合结论','conclusion']]) {
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
  const url = URL.createObjectURL(new Blob([output.join('\n') + '\n'], { type: 'text/markdown;charset=utf-8' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = 'MedEvidence-review.md';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function syncNavigation() {
  const pages = ['question', 'literature', 'review'];
  const section = window.location.hash.slice(1);
  const active = pages.includes(section) ? section : 'question';
  for (const id of pages) byId(id).hidden = id !== active;
  const selection = byId('reading-tools');
  const parent = byId(active === 'review' ? 'review-selection' : 'browse-grid');
  if (selection.parentElement !== parent) parent.append(selection);
  byId('view-review').hidden = active === 'review';
  for (const link of document.querySelectorAll('.nav-list a')) {
    if (link.getAttribute('href') === '#' + active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', () => {
  syncNavigation();
  window.scrollTo({ top: 0, behavior: 'instant' });
});
syncNavigation();
