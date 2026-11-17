package org.medevidence;

import java.util.List;

record Article(String pmid, String title, String abstractText, List<String> authors,
               String publicationDate, String pubmedUrl, String journal, String doi) {}
