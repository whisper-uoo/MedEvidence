package org.medevidence;

import java.time.Year;
import java.util.*;
import org.springframework.stereotype.Service;
import static org.springframework.http.HttpStatus.BAD_REQUEST;
import org.medevidence.LiteratureController.*;

@Service
final class LiteratureSearch {
    private static final int MAX_RESULTS = 10_000;
    private static final Map<String, String> TYPES = Map.of(
        "rct", "Randomized Controlled Trial", "systematic", "Systematic Review",
        "meta", "Meta-Analysis", "review", "Review", "clinical", "Clinical Trial");
    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(LiteratureSearch.class);
    private final QueryAdapter adapter;
    private final PubMedClient client;
    private final ModelClient model;
    private final EvidenceEngine engine;

    LiteratureSearch(QueryAdapter adapter, PubMedClient client, ModelClient model, EvidenceEngine engine) {
        this.adapter = adapter;
        this.client = client;
        this.model = model;
        this.engine = engine;
    }

    SearchResult search(SearchRequest request) {
        int limit = request.limit() == null ? 10 : request.limit();
        if (limit < 1 || limit > 50) throw new SearchProblem(BAD_REQUEST, "INVALID_LIMIT", "limit 必须为 1–50。");
        int page = request.page() == null ? 1 : request.page();
        if (page < 1 || (page - 1L) * limit >= MAX_RESULTS) {
            throw new SearchProblem(BAD_REQUEST, "INVALID_PAGE", "页码超出 PubMed 可访问的前 10000 条文献。");
        }
        String filter = filters(request);
        String query = query(request);
        String sent = filter.isEmpty() ? query : "(" + query + ")" + filter;
        int offset = (page - 1) * limit;
        var result = client.search(sent, Math.min(limit, MAX_RESULTS - offset), offset);
        var positions = new HashMap<String, Integer>();
        for (int i = 0; i < result.articles().size(); i++) positions.put(result.articles().get(i).pmid(), offset + i + 1);
        var ranked = Bm25.rank(query, result.articles());
        String notice = null;
        if (Boolean.TRUE.equals(request.semantic()) && !ranked.isEmpty()) {
            if (!model.available()) {
                notice = "模型未配置，已按 BM25 排序。";
            } else {
                try {
                    ranked = engine.rerank(request.query(), ranked);
                } catch (SearchProblem problem) {
                    LOG.warn("Semantic reranking failed: {}", problem.code);
                    notice = problem.getMessage() + " 已按 BM25 排序。";
                }
            }
        }
        return new SearchResult(sent, result.total(), ranked.stream().map(Bm25.Ranked::article).toList(),
            ranked.stream().map(item -> new Ranking(item.article().pmid(), item.bm25(), item.semanticScore(),
                item.reason(), positions.get(item.article().pmid()))).toList(),
            notice, page, limit, (int) Math.min(result.total(), MAX_RESULTS), query);
    }

    List<Ranking> rerank(LiteratureController.RerankRequest request) {
        String query = adapter.adapt(request.question(), request.englishQuery());
        var ids = request.pmids();
        if (ids == null || ids.isEmpty() || ids.size() > 50 || new HashSet<>(ids).size() != ids.size()
            || ids.stream().anyMatch(id -> id == null || !id.matches("[1-9][0-9]{0,11}"))) {
            throw new SearchProblem(BAD_REQUEST, "INVALID_CANDIDATES", "请选择 1–50 个不重复的有效 PMID。");
        }
        if (!model.available()) {
            throw new SearchProblem(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE, "AI_UNAVAILABLE", "尚未配置模型。");
        }
        var articles = client.fetch(ids);
        if (articles.size() != ids.size()) {
            throw new SearchProblem(org.springframework.http.HttpStatus.BAD_GATEWAY, "SOURCE_MISSING", "PubMed 未返回全部候选文献。");
        }
        var positions = new HashMap<String, Integer>();
        for (int i = 0; i < ids.size(); i++) positions.put(ids.get(i), i + 1);
        return engine.rerank(request.question(), Bm25.rank(query, articles)).stream().map(item ->
            new Ranking(item.article().pmid(), item.bm25(), item.semanticScore(), item.reason(),
                positions.get(item.article().pmid()))).toList();
    }

    private String filters(SearchRequest request) {
        int maxYear = Year.now().getValue() + 1;
        int start = request.fromYear() == null ? 1500 : request.fromYear();
        int end = request.toYear() == null ? maxYear : request.toYear();
        if (start < 1500 || end > maxYear || start > end) {
            throw new SearchProblem(BAD_REQUEST, "INVALID_YEAR", "请输入有效的发表年份范围。");
        }
        String filter = request.fromYear() == null && request.toYear() == null ? ""
            : " AND (" + start + ":" + end + "[Date - Publication])";
        if (request.publicationType() != null && !request.publicationType().isBlank()) {
            String type = TYPES.get(request.publicationType());
            if (type == null) throw new SearchProblem(BAD_REQUEST, "INVALID_TYPE", "不支持该文献类型筛选。");
            filter += " AND \"" + type + "\"[Publication Type]";
        }
        return filter;
    }

    private String query(SearchRequest request) {
        try {
            return adapter.adapt(request.query(), request.englishQuery());
        } catch (SearchProblem problem) {
            if (!problem.code.equals("ENGLISH_QUERY_REQUIRED") || !model.available()) throw problem;
            try {
                var translated = model.ask("""
                    将中文医学研究问题转换成英文 PubMed 检索式。
                    保留关键研究对象、暴露、干预和结局，使用明确的 AND/OR 及同义词。
                    仅输出 {"query":"英文检索式"}，勿添加问题中没有的限制或文献 ID。
                    """, Map.of("question", request.query()));
                return adapter.adapt(request.query(), EvidenceEngine.required(translated, "query", 1000));
            } catch (SearchProblem ex) {
                LOG.warn("Query translation failed: {}", ex.code);
                throw new SearchProblem(BAD_REQUEST, "ENGLISH_QUERY_REQUIRED", "无法可靠转换此问题，请补充英文检索式。");
            }
        }
    }
}
