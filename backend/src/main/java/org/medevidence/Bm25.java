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
        var documents = articles.stream().map(article ->
            words(Objects.toString(article.title(), "") + " " + Objects.toString(article.abstractText(), ""))).toList();
        var frequencies = documents.stream().map(words -> words.stream()
            .collect(Collectors.groupingBy(Function.identity(), Collectors.counting()))).toList();
        double average = Math.max(1, documents.stream().mapToInt(List::size).average().orElse(0));
        var weights = new HashMap<String, Double>();
        for (String term : terms) {
            long count = frequencies.stream().filter(doc -> doc.containsKey(term)).count();
            weights.put(term, Math.log1p((articles.size() - count + 0.5) / (count + 0.5)));
        }
        var ranked = new ArrayList<Ranked>();
        for (int i = 0; i < articles.size(); i++) {
            double lengthFactor = 1.2 * (0.25 + 0.75 * documents.get(i).size() / average);
            double score = 0;
            for (String term : terms) {
                long frequency = frequencies.get(i).getOrDefault(term, 0L);
                score += weights.get(term) * frequency * 2.2 / (frequency + lengthFactor);
            }
            ranked.add(new Ranked(articles.get(i), score, null, null));
        }
        ranked.sort(Comparator.comparingDouble(Ranked::bm25).reversed());
        return ranked;
    }

    private static List<String> words(String value) {
        return WORD.matcher(value.toLowerCase(Locale.ROOT)).results().map(result -> result.group())
            .filter(word -> !STOP.contains(word)).toList();
    }
}
