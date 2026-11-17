package org.medevidence;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

import static org.springframework.http.HttpStatus.BAD_REQUEST;

@Component
final class QueryAdapter {
    private static final Pattern HAN = Pattern.compile("\\p{IsHan}");
    private static final Map<String, String> TERMS = Map.ofEntries(
        Map.entry("2型糖尿病", "Diabetes Mellitus, Type 2"),
        Map.entry("二型糖尿病", "Diabetes Mellitus, Type 2"),
        Map.entry("糖尿病", "Diabetes Mellitus"),
        Map.entry("二甲双胍", "Metformin"),
        Map.entry("高血压", "Hypertension"),
        Map.entry("阿司匹林", "Aspirin"),
        Map.entry("心肌梗死", "Myocardial Infarction"),
        Map.entry("脑卒中", "Stroke"),
        Map.entry("卒中", "Stroke"),
        Map.entry("肥胖", "Obesity"),
        Map.entry("哮喘", "Asthma"),
        Map.entry("糖化血红蛋白", "Glycated Hemoglobin"),
        Map.entry("死亡率", "Mortality"),
        Map.entry("乳腺癌", "Breast Neoplasms"),
        Map.entry("肺癌", "Lung Neoplasms"),
        Map.entry("慢性肾病", "Chronic Kidney Disease"),
        Map.entry("心力衰竭", "Heart Failure"),
        Map.entry("冠心病", "Coronary Artery Disease"),
        Map.entry("抑郁症", "Depressive Disorder"),
        Map.entry("吸入糖皮质激素", "Inhaled Corticosteroids"),
        Map.entry("糖化血红蛋白水平", "Glycated Hemoglobin"),
        Map.entry("患病风险", "Disease Risk"),
        Map.entry("成年人", "Adult"),
        Map.entry("成人", "Adult")
    );
    private static final Pattern TOKENS = Pattern.compile(
        String.join("|", TERMS.keySet().stream()
            .sorted(java.util.Comparator.comparingInt(String::length).reversed()).toList())
        + "|随机对照试验|系统评价|是否|能否|可以|影响|效果|治疗|降低|改善|预防|患者|作用|什么|如何|对于|用于|研究|[的对在中有能是吗和与及\\s\\p{P}？]"
    );

    String adapt(String question, String englishQuery) {
        validate(question);
        if (englishQuery != null && !englishQuery.isBlank()) {
            validate(englishQuery);
            if (HAN.matcher(englishQuery).find()) {
                throw new SearchProblem(BAD_REQUEST, "INVALID_QUERY", "补充检索词须使用英文。");
            }
            return englishQuery.strip();
        }
        if (!HAN.matcher(question).find()) {
            return question.strip();
        }

        var concepts = new LinkedHashSet<String>();
        String normalized = question.replaceAll("\\s+", "");
        var tokens = TOKENS.matcher(normalized);
        int end = 0;
        while (tokens.find()) {
            if (end != tokens.start()) {
                throw unsupported();
            }
            end = tokens.end();
            String term = TERMS.get(tokens.group());
            if (term != null) {
                concepts.add("(\"" + term + "\"[MeSH Terms] OR \"" + term + "\"[Title/Abstract])");
            } else if (tokens.group().equals("随机对照试验")) {
                concepts.add("\"Randomized Controlled Trial\"[Publication Type]");
            } else if (tokens.group().equals("系统评价")) {
                concepts.add("\"Systematic Review\"[Publication Type]");
            }
        }
        if (end != normalized.length() || concepts.isEmpty()) {
            throw unsupported();
        }
        return String.join(" AND ", concepts);
    }

    private void validate(String value) {
        if (value == null || value.isBlank() || value.length() > 1000) {
            throw new SearchProblem(BAD_REQUEST, "INVALID_QUERY", "检索问题和补充检索词须为 1–1000 个字符。");
        }
    }

    private SearchProblem unsupported() {
        return new SearchProblem(BAD_REQUEST, "ENGLISH_QUERY_REQUIRED", "当前术语表无法覆盖该问题，请补充英文检索词。");
    }
}
