package org.medevidence;

import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@CrossOrigin(origins = "${app.frontend-origin}")
@RequestMapping("/api/literature")
final class LiteratureController {
    private final LiteratureSearch search;

    LiteratureController(LiteratureSearch search) {
        this.search = search;
    }

    record SearchRequest(String query, String englishQuery, Integer limit, Boolean semantic,
                         Integer page, Integer fromYear, Integer toYear, String publicationType) {}
    record SearchResult(String pubmedQuery, long total, List<Article> articles,
                        List<Ranking> rankings, String rankingNotice, int page, int limit,
                        int accessibleTotal, String englishQuery) {}
    record Ranking(String pmid, double bm25, Integer semanticScore, String reason, int pubmedRank) {}

    record RerankRequest(String question, String englishQuery, List<String> pmids) {}

    @PostMapping("/rerank")
    ApiResponse rerank(@RequestBody RerankRequest request) {
        return new ApiResponse("OK", "语义重排序完成。", search.rerank(request));
    }

    @PostMapping("/search")
    ApiResponse search(@RequestBody SearchRequest request) {
        var result = search.search(request);
        return new ApiResponse(result.articles().isEmpty() ? "NO_RESULTS" : "OK",
            result.articles().isEmpty() ? "当前页没有匹配文献。" : "检索成功。", result);
    }
}
