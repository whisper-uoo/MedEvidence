package org.medevidence;

import java.util.*;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

final class Bm25 {
    private static final Pattern WORD = Pattern.compile("[\\p{L}\\p{N}]+");
    private static final Set<String> STOP = Set.of("a", "an", "the", "of", "to", "and", "or", "in",
        "on", "for", "by", "with", "does", "is", "what", "how", "are", "mesh", "terms", "title", "abstract",
        "publication", "type");

    record Ranked(Article article, double bm25, Integer semanticScore, String reason) {}

    static List<Ranked> rank(String query, List<Article> articles) {
        var terms = new LinkedHashSet<>(words(query.replaceAll("\\[[^\\]]*\\]", "")));
        var titles = articles.stream().map(article -> words(Objects.toString(article.title(), ""))).toList();
        var abstracts = articles.stream().map(article -> words(Objects.toString(article.abstractText(), ""))).toList();
        var titleTf = frequencies(titles);
        var abstractTf = frequencies(abstracts);
        double titleAverage = averageLength(titles);
        double abstractAverage = averageLength(abstracts);
        var weights = new HashMap<String, Double>();
        for (String term : terms) {
            long count = java.util.stream.IntStream.range(0, articles.size())
                .filter(i -> titleTf.get(i).containsKey(term) || abstractTf.get(i).containsKey(term)).count();
            weights.put(term, Math.log1p((articles.size() - count + 0.5) / (count + 0.5)));
        }
        var ranked = new ArrayList<Ranked>();
        for (int i = 0; i < articles.size(); i++) {
            double titleNorm = 0.25 + 0.75 * titles.get(i).size() / titleAverage;
            double abstractNorm = 0.25 + 0.75 * abstracts.get(i).size() / abstractAverage;
            double score = 0;
            for (String term : terms) {
                double frequency = 2.0 * titleTf.get(i).getOrDefault(term, 0L) / titleNorm
                    + abstractTf.get(i).getOrDefault(term, 0L) / abstractNorm;
                score += weights.get(term) * frequency * 2.2 / (frequency + 1.2);
            }
            ranked.add(new Ranked(articles.get(i), score, null, null));
        }
        ranked.sort(Comparator.comparingDouble(Ranked::bm25).reversed());
        return ranked;
    }

    private static List<Map<String, Long>> frequencies(List<List<String>> fields) {
        return fields.stream().map(tokens -> tokens.stream()
            .collect(Collectors.groupingBy(Function.identity(), Collectors.counting()))).toList();
    }

    private static double averageLength(List<List<String>> fields) {
        return Math.max(1, fields.stream().mapToInt(List::size).average().orElse(0));
    }

    private static List<String> words(String value) {
        return WORD.matcher(value.toLowerCase(Locale.ROOT)).results().map(result -> result.group())
            .filter(word -> !STOP.contains(word)).toList();
    }
}
