package org.medevidence;

import java.io.*;
import java.util.*;
import java.util.stream.Collectors;
import javax.xml.XMLConstants;
import javax.xml.parsers.*;
import org.w3c.dom.*;
import org.xml.sax.*;
import org.xml.sax.helpers.DefaultHandler;

import static org.springframework.http.HttpStatus.BAD_GATEWAY;

final class PubMedXml {
    record Matches(long total, List<String> ids) {}

    Matches matches(InputStream input) {
        Element root = parse(input, "eSearchResult");
        if (child(child(root, "ErrorList"), "FieldNotFound") != null) {
            throw new SearchProblem(org.springframework.http.HttpStatus.BAD_REQUEST,
                "INVALID_QUERY", "PubMed 检索式包含未知字段标签。");
        }
        var ids = children(child(root, "IdList"), "Id").stream().map(Element::getTextContent).map(String::strip).distinct().toList();
        try {
            long count = Long.parseLong(value(root, "Count"));
            if (count < ids.size()
                || ids.stream().anyMatch(id -> !id.matches("[0-9]+"))) {
                throw invalidResponse();
            }
            return new Matches(count, ids);
        } catch (NumberFormatException ex) {
            throw invalidResponse();
        }
    }

    List<Article> articles(InputStream input) {
        Element root = parse(input, "PubmedArticleSet");
        var result = new ArrayList<Article>();
        for (Element entry : children(root, "PubmedArticle", "PubmedBookArticle")) {
            Element citation = child(entry, "MedlineCitation", "BookDocument");
            String id = value(citation, "PMID");
            if (id == null || !id.matches("[0-9]+")) {
                continue;
            }
            boolean book = citation.getTagName().equals("BookDocument");
            Element article = book ? citation : child(citation, "Article");
            Element date = book ? child(child(article, "Book"), "PubDate")
                : child(child(child(article, "Journal"), "JournalIssue"), "PubDate");
            String publication = date(date);
            if (publication == null) {
                publication = date(child(article, "ArticleDate"));
            }
            var authors = children(article, "AuthorList").stream()
                .flatMap(list -> children(list, "Author").stream())
                .map(this::author).filter(Objects::nonNull).toList();
            String summary = children(child(article, "Abstract"), "AbstractText").stream()
                .filter(section -> !section.getTextContent().isBlank())
                .map(section -> {
                    String label = section.getAttribute("Label");
                    return (label.isBlank() ? "" : label + ": ") + section.getTextContent().strip();
                }).collect(Collectors.joining("\n\n"));
            String doi = children(article, "ELocationID").stream()
                .filter(field -> "doi".equals(field.getAttribute("EIdType")))
                .map(Element::getTextContent).filter(text -> !text.isBlank()).findFirst().orElse(null);
            if (doi == null) {
                doi = children(child(child(entry, "PubmedData", "PubmedBookData"), "ArticleIdList"), "ArticleId")
                    .stream().filter(field -> "doi".equals(field.getAttribute("IdType")))
                    .map(Element::getTextContent).filter(text -> !text.isBlank()).findFirst().orElse(null);
            }
            result.add(new Article(id, value(article, "ArticleTitle", "BookTitle"),
                summary.isBlank() ? null : summary, authors, publication, "https://pubmed.ncbi.nlm.nih.gov/" + id + "/", value(child(article, "Journal"), "Title"), doi,
                children(child(article, "PublicationTypeList"), "PublicationType").stream()
                    .map(Element::getTextContent).map(String::strip).filter(type -> !type.isEmpty()).distinct().toList()));
        }
        return result;
    }

    private String author(Element author) {
        String group = value(author, "CollectiveName");
        if (group != null) {
            return group;
        }
        String first = value(author, "ForeName");
        return join(" ", first == null ? value(author, "Initials") : first,
            value(author, "LastName"), value(author, "Suffix"));
    }

    private String date(Element date) {
        String range = value(date, "MedlineDate");
        return range == null ? join(" ", value(date, "Year"), value(date, "Month"),
            value(date, "Day"), value(date, "Season")) : range;
    }

    private String join(String delimiter, String... parts) {
        String joined = Arrays.stream(parts).filter(Objects::nonNull).collect(Collectors.joining(delimiter));
        return joined.isBlank() ? null : joined;
    }

    private Element parse(InputStream input, String expected) {
        try {
            var factory = DocumentBuilderFactory.newInstance();
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            var builder = factory.newDocumentBuilder();
            builder.setErrorHandler(new DefaultHandler());
            Element root = builder.parse(input).getDocumentElement();
            if (!root.getTagName().equals(expected) || child(root, "ERROR", "Error") != null) {
                throw invalidResponse();
            }
            return root;
        } catch (IOException | SAXException | ParserConfigurationException ex) {
            throw invalidResponse();
        }
    }

    static SearchProblem invalidResponse() {
        return new SearchProblem(BAD_GATEWAY, "PUBMED_INVALID_RESPONSE", "PubMed 返回了无法处理的数据。");
    }

    private static Element child(Element parent, String... names) {
        return children(parent, names).stream().findFirst().orElse(null);
    }

    private static List<Element> children(Element parent, String... names) {
        var found = new ArrayList<Element>();
        if (parent != null) {
            for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
                if (node instanceof Element element && List.of(names).contains(element.getTagName())) {
                    found.add(element);
                }
            }
        }
        return found;
    }

    private static String value(Element parent, String... names) {
        Element field = child(parent, names);
        if (field == null || field.getTextContent().isBlank()) {
            return null;
        }
        return field.getTextContent().strip();
    }
}
