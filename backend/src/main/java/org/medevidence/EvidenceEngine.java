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
    record Source(String pmid, String title, String abstractText) {}
    record Evidence(String pmid, String studyDesign, String finding, String limitation, String quote) {}
    record Point(String text, List<String> pmids) {}
    record Review(List<Evidence> evidence, List<Point> findings, List<Point> differences, List<Point> limitations,
                  List<String> missingAbstractPmids) {}

    EvidenceEngine(ModelClient model) {
        this.model = model;
    }

    List<Bm25.Ranked> rerank(String question, List<Bm25.Ranked> ranked) {
        var candidates = ranked.stream().limit(12).toList();
        JsonNode scores = model.ask("""
            给每个输入文献按其标题和摘要与研究问题的相关性打 0–100 整数分，并用中文简述匹配的主题或差距。
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
            对每篇摘要独立提取证据。仅依据提供的摘要，使用中文描述研究设计、发现、局限。
            未报告的内容使用“摘要未报告”，相关性只能描述为相关性。对每篇文献复制一段摘要原文作为 quote，
            必须是逐字连续片段，最多 600 字符，不得翻译或增删。每个输入 PMID 恰好出现一次。
            {"evidence":[{"pmid":"输入 PMID","studyDesign":"研究设计","finding":"主要发现","limitation":"局限","quote":"摘要原文"}]}
            """, Map.of("question", question, "articles", sources)).path("evidence");
        var evidence = validateEvidence(extracted, sources);
        JsonNode synthesis = model.ask("""
            只依据输入结构化证据撰写中文综述。每条陈述都列出支持它的输入 PMID，绝不能补写摘要未报告的事实。
            明确区分观察关联与因果，比较结论时说明研究设计、对象或终点差异，仅在证据明确时描述冲突。
            每组可为空，无法比较时留空。使用纯文本，引用只放 pmids 字段。
            {"findings":[{"text":"发现","pmids":["输入 PMID"]}],"differences":[],"limitations":[]}
            """, Map.of("question", question, "evidence", evidence));
        var allowed = evidence.stream().map(Evidence::pmid).collect(Collectors.toSet());
        return new Review(evidence, points(synthesis.path("findings"), allowed),
            points(synthesis.path("differences"), allowed), points(synthesis.path("limitations"), allowed),
            articles.stream().filter(a -> a.abstractText() == null).map(Article::pmid).toList());
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
                checkedText(row, "finding", 1000, allowed), checkedText(row, "limitation", 1000, allowed), quote));
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
