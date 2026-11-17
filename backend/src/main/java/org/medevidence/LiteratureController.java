package org.medevidence;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@CrossOrigin(origins = "${app.frontend-origin}")
@RequestMapping("/api/literature")
final class LiteratureController {
    private final QueryAdapter adapter;
    private final PubMedClient client;
    private final ModelClient model;
    private final EvidenceEngine engine;

    LiteratureController(QueryAdapter adapter, PubMedClient client, ModelClient model, EvidenceEngine engine) {
        this.adapter = adapter;
        this.client = client;
        this.model = model;
        this.engine = engine;
    }

    record SearchRequest(String query, String englishQuery, Integer limit, Boolean semantic) {}
    record SearchResult(String pubmedQuery, long total, List<Article> articles,
                        List<Ranking> rankings, String rankingNotice) {
        SearchResult(String pubmedQuery, long total, List<Article> articles) {
            this(pubmedQuery, total, articles, List.of(), null);
        }
    }
    record Ranking(String pmid, double bm25, Integer semanticScore, String reason) {}

    @PostMapping("/search")
    ApiResponse search(@RequestBody SearchRequest request) {
        int limit = request.limit() == null ? 10 : request.limit();
        if (limit < 1 || limit > 50) {
            throw new SearchProblem(org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_LIMIT", "limit 必须为 1–50。");
        }
        String query;
        try {
            query = adapter.adapt(request.query(), request.englishQuery());
        } catch (SearchProblem problem) {
            if (!problem.code.equals("ENGLISH_QUERY_REQUIRED") || !model.available()) throw problem;
            var translated = model.ask("""
                将中文医学研究问题转换成英文 PubMed 检索式。
                保留关键研究对象、暴露、干预和结局，使用明确的 AND/OR 及同义词。
                仅输出 {"query":"英文检索式"}，勿添加问题中没有的限制或文献 ID。
                """, java.util.Map.of("question", request.query()));
            query = adapter.adapt(request.query(), EvidenceEngine.required(translated, "query", 1000));
        }
        SearchResult result = client.search(query, limit);
        var ranked = Bm25.rank(query, result.articles());
        String notice = null;
        if (Boolean.TRUE.equals(request.semantic()) && !ranked.isEmpty()) {
            if (!model.available()) {
                notice = "模型未配置，已按 BM25 排序。";
            } else {
                try {
                    ranked = engine.rerank(request.query(), ranked);
                } catch (SearchProblem problem) {
                    org.slf4j.LoggerFactory.getLogger(getClass()).warn("Semantic reranking failed: {}", problem.code);
                    notice = problem.getMessage() + " 已按 BM25 排序。";
                }
            }
        }
        result = new SearchResult(query, result.total(), ranked.stream().map(Bm25.Ranked::article).toList(),
            ranked.stream().map(item -> new Ranking(item.article().pmid(), item.bm25(),
                item.semanticScore(), item.reason())).toList(), notice);
        return new ApiResponse(result.total() == 0 ? "NO_RESULTS" : "OK",
            result.total() == 0 ? "未找到匹配文献。" : "检索成功。", result);
    }

}
