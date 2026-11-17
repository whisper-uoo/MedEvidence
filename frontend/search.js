const apiOrigin = window.MED_EVIDENCE_API_ORIGIN ?? 'http://localhost:8080';
const byId = id => document.getElementById(id);
const form = byId('search');
const results = byId('results');
const status = byId('status');
const reviewStatus = byId('review-status');
const selected = new Map();
let articles = [];
let rankings = new Map();
let question = '';
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
  byId('review-button').disabled = searching || reviewing || !capabilities.review || selected.size === 0;
}

function renderSelected() {
  const list = byId('selected');
  list.replaceChildren();
  byId('selection-count').textContent = `已选 ${selected.size} / 8 篇`;
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

function renderArticle(article) {
  const card = element('article');
  const head = element('div', '', 'article-head');
  const title = element('h3');
  title.append(pubmed(article.pmid, article.title ?? '标题未收录'));
  const label = element('label', '', 'toggle');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(article.pmid);
  checkbox.disabled = reviewing;
  checkbox.setAttribute('aria-label', '选入综述 ' + (article.title ?? article.pmid));
  checkbox.onchange = () => {
    if (checkbox.checked && selected.size >= 8) {
      checkbox.checked = false;
      reviewStatus.textContent = '每份综述最多选择 8 篇文献。';
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
  if (article.authors.length) card.append(element('p', article.authors.join(', '), 'meta'));
  const rank = rankings.get(article.pmid);
  if (rank) {
    const scores = [`BM25 ${rank.bm25.toFixed(2)}`];
    if (rank.semanticScore !== null) scores.push(`模型相关性 ${rank.semanticScore}/100`);
    card.append(element('p', scores.join(' · '), 'meta'));
    if (rank.reason) card.append(element('p', rank.reason, 'reason'));
  }
  const details = element('details');
  details.append(element('summary', article.abstractText ? '展开摘要' : '摘要未收录'),
    element('p', article.abstractText ?? 'PubMed 未提供此文献的摘要。', 'abstract'));
  card.append(details);
  return card;
}

function year(article) {
  return Number(article.publicationDate?.match(/\b\d{4}\b/)?.[0] ?? 0);
}

function renderResults() {
  const filter = byId('filter').value.trim().toLowerCase();
  const visible = articles.filter(article => (!byId('abstract-only').checked || article.abstractText) &&
    [article.title, article.journal, article.pmid, ...article.authors]
      .some(field => field?.toLowerCase().includes(filter)));
  const sort = byId('sort').value;
  if (sort === 'year') visible.sort((a, b) => year(b) - year(a));
  if (sort === 'bm25') visible.sort((a, b) => rankings.get(b.pmid).bm25 - rankings.get(a.pmid).bm25);
  results.replaceChildren(...visible.map(renderArticle));
  if (articles.length && !visible.length) results.append(element('p', '当前筛选条件下没有文献。', 'note'));
}

form.onsubmit = async event => {
  event.preventDefault();
  if (searching || reviewing) return;
  searching = true;
  const button = byId('search-button');
  button.disabled = true;
  updateReviewButton();
  status.textContent = '正在检索 PubMed…';
  const submitted = byId('query').value.trim();
  try {
    const body = await api('/literature/search', {
      query: submitted, englishQuery: byId('english').value.trim(), limit: 30, semantic: byId('semantic').checked,
    }, 75000);
    question = submitted;
    articles = body.data.articles;
    rankings = new Map(body.data.rankings.map(rank => [rank.pmid, rank]));
    selected.clear();
    reviewStatus.textContent = capabilities.review ? '' : '需要配置模型与 MySQL 才能生成综述。';
    byId('review-result').replaceChildren();
    byId('filter').value = '';
    byId('sort').value = 'rank';
    byId('abstract-only').checked = false;
    byId('filters').hidden = !articles.length;
    const expression = byId('expression');
    expression.querySelector('p').textContent = body.data.pubmedQuery;
    expression.hidden = false;
    const notice = byId('ranking-notice');
    notice.textContent = body.data.rankingNotice ?? '';
    notice.hidden = !notice.textContent;
    status.textContent = articles.length
      ? `匹配 ${body.data.total.toLocaleString()} 篇 · 当前候选 ${articles.length} 篇`
      : body.message;
    renderSelected();
    renderResults();
  } catch (error) {
    status.textContent = error.message + (articles.length ? ' 仍显示上一次检索结果。' : '');
    if (error.code === 'ENGLISH_QUERY_REQUIRED') {
      byId('english-options').open = true;
      byId('english').focus();
    }
  } finally {
    searching = false;
    button.disabled = false;
    updateReviewButton();
  }
};

function renderReview(review) {
  const target = byId('review-result');
  target.replaceChildren();
  for (const [label, key] of [['研究发现', 'findings'], ['不同结论', 'differences'], ['研究局限', 'limitations']]) {
    const group = element('section');
    group.append(element('h3', label));
    if (review[key].length === 0) group.append(element('p', '所选摘要未提供足够证据。', 'note'));
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
    group.append(pubmed(item.pmid), element('p', '研究设计 · ' + item.studyDesign),
      element('p', '发现 · ' + item.finding), element('p', '局限 · ' + item.limitation),
      element('blockquote', item.quote));
    extracts.append(group);
  }
  target.append(extracts);
}

async function followReview(task) {
  const deadline = Date.now() + 165000;
  while (task.state === 'QUEUED' || task.state === 'RUNNING') {
    reviewStatus.textContent = task.state === 'QUEUED' ? '任务已排队…' : '正在提取并综合摘要证据…';
    if (Date.now() >= deadline) throw new Error('等待任务状态超时。再次提交同一选题可查询原任务。');
    await new Promise(resolve => setTimeout(resolve, 2000));
    task = (await api('/reviews/' + task.id)).data;
  }
  if (task.state !== 'SUCCEEDED') throw new Error(task.message ?? '综述任务失败。');
  renderReview(task.result);
  reviewStatus.textContent = '综述已生成。';
}

byId('review-button').onclick = async () => {
  if (reviewing || searching || !selected.size) return;
  reviewing = true;
  byId('search-button').disabled = true;
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
    byId('search-button').disabled = false;
    renderSelected();
    renderResults();
  }
};

byId('filter').oninput = renderResults;
byId('sort').onchange = renderResults;
byId('abstract-only').onchange = renderResults;

try {
  capabilities = (await api('/capabilities')).data;
  byId('semantic').disabled = !capabilities.semantic;
  byId('model-state').textContent = capabilities.semantic ? '' : '模型未配置';
  if (!capabilities.review) reviewStatus.textContent = '需要配置模型与 MySQL 才能生成综述。';
} catch {
  byId('model-state').textContent = '无法读取后端配置';
}
