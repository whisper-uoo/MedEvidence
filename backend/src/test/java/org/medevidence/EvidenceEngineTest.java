package org.medevidence;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class EvidenceEngineTest {
    private final ObjectMapper json = new ObjectMapper();

    private Article article(String id, String title, String summary) {
        return new Article(id, title, summary, List.of(), null, null, null, null);
    }

    @Test
    void ranksTitleAndAbstractAndHandlesMissingFields() {
        var ranked = Bm25.rank("asthma[Title/Abstract]", List.of(
            article("1", "Editorial", null), article("2", "Asthma", "Asthma cohort")));
        assertEquals("2", ranked.get(0).article().pmid());
        assertTrue(ranked.get(0).bm25() > 0);
        assertEquals(0, ranked.get(1).bm25());
    }

    @Test
    void validatesSemanticScoresAgainstCandidateSet() throws Exception {
        var model = mock(ModelClient.class);
        var engine = new EvidenceEngine(model);
        var ranked = Bm25.rank("asthma", List.of(article("1", "Asthma", null), article("2", "Other", null)));
        when(model.ask(anyString(), any())).thenReturn(json.readTree("""
            {"scores":[{"pmid":"2","score":90,"reason":"relevant"},{"pmid":"1","score":10,"reason":"weak"}]}
            """), json.readTree("""
            {"scores":[{"pmid":"9","score":90,"reason":"unknown"},{"pmid":"1","score":10,"reason":"weak"}]}
            """));
        assertEquals("2", engine.rerank("asthma", ranked).get(0).article().pmid());
        assertEquals("AI_INVALID_RESPONSE", assertThrows(SearchProblem.class, () -> engine.rerank("asthma", ranked)).code);
    }

    @Test
    void extractionRequiresVerbatimQuoteAndKnownId() throws Exception {
        var sources = List.of(new EvidenceEngine.Source("1", "Title", "An exact test fixture."));
        var rows = """
            [{"pmid":"1","studyDesign":"Test","finding":"Test","limitation":"Test","quote":"exact test fixture"}]
            """;
        assertEquals("1", EvidenceEngine.validateEvidence(json.readTree(rows), sources).get(0).pmid());
        assertThrows(SearchProblem.class, () ->
            EvidenceEngine.validateEvidence(json.readTree(rows.replace("exact", "invented")), sources));
        assertThrows(SearchProblem.class, () ->
            EvidenceEngine.validateEvidence(json.readTree(rows.replace("\"1\"", "\"2\"")), sources));
    }

    @Test
    void synthesisRequiresAllowedNonemptyCitations() throws Exception {
        assertEquals(List.of("1"), EvidenceEngine.points(
            json.readTree("[{\"text\":\"Test\",\"pmids\":[\"1\"]}]"), Set.of("1")).get(0).pmids());
        assertThrows(SearchProblem.class, () -> EvidenceEngine.points(
            json.readTree("[{\"text\":\"PMID 999\",\"pmids\":[\"1\"]}]"), Set.of("1")));
        assertThrows(SearchProblem.class, () -> EvidenceEngine.points(
            json.readTree("[{\"text\":\"Test\",\"pmids\":[\"2\"]}]"), Set.of("1")));
        assertThrows(SearchProblem.class, () -> EvidenceEngine.points(
            json.readTree("[{\"text\":\"Test\",\"pmids\":[]}]"), Set.of("1")));
    }
}
