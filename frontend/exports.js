export function markdownText(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, character => '\\' + character);
}

export function citation(id) {
  return `[PMID ${id}](https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(id)}/)`;
}

export function literatureMarkdown(articles) {
  const entries = articles.map(article => '- ' + citation(article.pmid) + ' · '
    + [article.title, article.authors?.join(', '), article.journal, article.publicationDate, article.doi]
      .filter(Boolean).map(markdownText).join(' · '));
  return ['# MedEvidence 文献清单', '', ...entries, ''].join('\n');
}

function bibText(value) {
  const escapes = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&',
    '%': '\\%', '#': '\\#', '_': '\\_', '$': '\\$', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\{}&%#_$~^]/g, ch => escapes[ch]);
}

export function literatureBibtex(articles) {
  return articles.map(article => {
    const fields = {
      title: article.title ? '{' + bibText(article.title) + '}' : null,
      author: article.authors?.length ? article.authors.map(author => '{' + bibText(author) + '}').join(' and ') : null,
      journal: article.journal && bibText(article.journal),
      year: article.publicationDate?.match(/^\d{4}\b/)?.[0],
      doi: article.doi && bibText(article.doi),
      pmid: bibText(article.pmid),
      url: 'https://pubmed.ncbi.nlm.nih.gov/' + encodeURIComponent(article.pmid) + '/',
    };
    return `@${fields.journal ? 'article' : 'misc'}{pubmed${article.pmid},\n`
      + Object.entries(fields).filter(([, value]) => value)
        .map(([name, value]) => `  ${name} = {${value}}`).join(',\n') + '\n}';
  }).join('\n\n') + '\n';
}

export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
