package org.medevidence;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.*;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;

@Component
final class EvidenceEngine {
    private static final Pattern INLINE_PMID = Pattern.compile("(?i)\\bPMID\\s*[:：]?\\s*([0-9]+)");
    private final ModelClient model;
    private final int candidateLimit;
    record Source(String pmid, String title, String abstractText) {}
    record Evidence(String pmid, String studyDesign, String finding, String limitation, String quote,
                    String population, String objective, String interpretation) {}
    record Point(String text, List<String> pmids) {}
    record Review(List<Evidence> evidence, List<Point> findings, List<Point> differences, List<Point> limitations,
                  List<String> missingAbstractPmids, String question, List<Point> agreement, List<Point> conclusion,
                  List<Article> references) {}

    EvidenceEngine(ModelClient model, @org.springframework.beans.factory.annotation.Value("${ai.rerank-limit:20}") int candidateLimit) {
        this.model = model;
        if (candidateLimit < 1 || candidateLimit > 50) throw new IllegalArgumentException("AI_RERANK_LIMIT must be 1–50");
        this.candidateLimit = candidateLimit;
    }

    List<Bm25.Ranked> rerank(String question, List<Bm25.Ranked> ranked) {
        var candidates = ranked.stream().limit(candidateLimit).toList();
        JsonNode scores = model.ask("""
            给每个输入文献按其标题和摘要与研究问题的相关性打 0–100 整数分，并用中文说明研究对象、因素和结局与问题的匹配或缺口。
            分数只衡量相关性。每个给定 PMID 恰好出现一次。结构为
            {"scores":[{"pmid":"输入 PMID","score":0,"reason":"相关性理由"}]}。
            """, Map.of("question", question, "articles", candidates.stream()
                .map(item -> source(item.article(), 2400)).toList())).path("scores");
        var byId = candidates.stream().collect(Collectors.toMap(item -> item.article().pmid(), Function.identity()));
        var sorted = new ArrayList<Bm25.Ranked>();
        if (!scores.isArray() || scores.size() != candidates.size()) throw ModelClient.invalid();
        for (var item : scores) {
            var base = byId.remove(required(item, "pmid", 12));
            var score = item.path("score");
            if (base == null || !score.isIntegralNumber() || !score.canConvertToInt()
                || score.intValue() < 0 || score.intValue() > 100) throw ModelClient.invalid();
            sorted.add(new Bm25.Ranked(base.article(), base.bm25(), score.intValue(), checkedText(item, "reason", 500, Set.of(base.article().pmid()))));
        }
        sorted.sort(Comparator.comparingInt(Bm25.Ranked::semanticScore).reversed()
            .thenComparing(Comparator.comparingDouble(Bm25.Ranked::bm25).reversed()));
        sorted.addAll(ranked.subList(candidates.size(), ranked.size()));
        return sorted;
    }

    Review review(String question, List<Article> articles) {
        var sources = articles.stream().filter(a -> a.abstractText() != null).map(a -> source(a, 6000)).toList();
        if (sources.isEmpty()) {
            throw new SearchProblem(org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                "NO_ABSTRACTS", "所选文献均无摘要，无法提取证据。");
        }
        JsonNode extracted = model.ask("""
            对每篇摘要独立提取证据。仅依据提供的摘要，使用中文描述研究对象、研究目的、研究方法、作者报告的发现、局限和模型解读。
            未报告的内容使用“摘要未提供”，相关性只能描述为相关性。将作者报告的发现与模型解释分列；解读无法判断时明示。对每篇文献复制一段摘要原文作为 quote，
            必须是逐字连续片段，最多 600 字符，不得翻译或增删。每个输入 PMID 恰好出现一次。
            {"evidence":[{"pmid":"输入 PMID","population":"研究对象","objective":"目的","studyDesign":"研究方法","finding":"作者报告的发现","limitation":"局限","interpretation":"模型解读","quote":"摘要原文"}]}
            """, Map.of("question", question, "articles", sources)).path("evidence");
        var evidence = validateEvidence(extracted, sources);
        JsonNode synthesis = model.ask("""
            只依据输入结构化证据撰写中文综述。每条陈述都列出支持它的输入 PMID，绝不能补写摘要未报告的事实。
            明确区分观察关联与因果，比较结论时说明研究设计、对象或终点差异，仅在证据明确时描述冲突。
            无法比较时留空。有结论时说明适用范围；证据不足时说明原因。使用纯文本，引用只放 pmids 字段。
            {"findings":[{"text":"发现","pmids":["输入 PMID"]}],"agreement":[],"differences":[],"limitations":[],"conclusion":[]}
            """, Map.of("question", question, "evidence", evidence));
        var allowed = evidence.stream().map(Evidence::pmid).collect(Collectors.toSet());
        return new Review(evidence, points(synthesis.path("findings"), allowed),
            points(synthesis.path("differences"), allowed), points(synthesis.path("limitations"), allowed),
            articles.stream().filter(a -> a.abstractText() == null).map(Article::pmid).toList(),
            question, points(synthesis.path("agreement"), allowed), points(synthesis.path("conclusion"), allowed),
            List.copyOf(articles));
    }

    static List<Evidence> validateEvidence(JsonNode rows, List<Source> sources) {
        if (!rows.isArray() || rows.size() != sources.size()) throw ModelClient.invalid();
        var byId = sources.stream().collect(Collectors.toMap(Source::pmid, Function.identity()));
        var result = new ArrayList<Evidence>();
        for (var row : rows) {
            String id = required(row, "pmid", 12);
            var source = byId.remove(id);
            String quote = required(row, "quote", 600);
            if (source == null || !source.abstractText().contains(quote)) throw ModelClient.invalid();
            var allowed = Set.of(id);
            result.add(new Evidence(id, checkedText(row, "studyDesign", 600, allowed),
                checkedText(row, "finding", 1000, allowed), checkedText(row, "limitation", 1000, allowed), quote,
                checkedText(row, "population", 600, allowed), checkedText(row, "objective", 600, allowed),
                checkedText(row, "interpretation", 800, allowed)));
        }
        return List.copyOf(result);
    }

    static List<Point> points(JsonNode rows, Set<String> allowed) {
        if (!rows.isArray() || rows.size() > 12) throw ModelClient.invalid();
        var result = new ArrayList<Point>();
        for (var row : rows) {
            var ids = row.path("pmids");
            if (!ids.isArray() || ids.isEmpty() || ids.size() > allowed.size()) throw ModelClient.invalid();
            var citations = new LinkedHashSet<String>();
            for (var id : ids) {
                if (!id.isTextual() || !allowed.contains(id.asText()) || !citations.add(id.asText())) {
                    throw ModelClient.invalid();
                }
            }
            result.add(new Point(checkedText(row, "text", 1200, citations), List.copyOf(citations)));
        }
        return List.copyOf(result);
    }

    private static String checkedText(JsonNode node, String key, int max, Set<String> allowed) {
        String value = required(node, key, max);
        if (INLINE_PMID.matcher(value).results().anyMatch(match -> !allowed.contains(match.group(1)))) {
            throw ModelClient.invalid();
        }
        return value;
    }

    static String required(JsonNode node, String key, int max) {
        var value = node.path(key);
        if (!value.isTextual() || value.asText().isBlank() || value.asText().length() > max) {
            throw ModelClient.invalid();
        }
        return value.asText();
    }

    private Source source(Article article, int max) {
        String summary = article.abstractText();
        if (summary != null && summary.length() > max) summary = summary.substring(0, max);
        return new Source(article.pmid(), article.title(), summary);
    }
}
