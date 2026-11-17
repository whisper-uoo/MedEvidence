package org.medevidence;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class ReviewTasksTest {
    private final ReviewStore store = mock(ReviewStore.class);
    private final PubMedClient pubmed = mock(PubMedClient.class);
    private final ModelClient model = mock(ModelClient.class);
    private final EvidenceEngine engine = mock(EvidenceEngine.class);

    @Test
    void validatesInputBeforeCallingDependencies() {
        var tasks = new ReviewTasks(store, pubmed, model, engine, new ObjectMapper());
        try {
            assertEquals("INVALID_REVIEW", assertThrows(SearchProblem.class,
                () -> tasks.submit("Question", List.of("1,2"))).code);
            assertEquals("AI_UNAVAILABLE", assertThrows(SearchProblem.class,
                () -> tasks.submit("Question", List.of("1"))).code);
            verifyNoInteractions(store, pubmed, engine);
        } finally {
            tasks.close();
        }
    }

    @Test
    void duplicateSelectionUsesSameTaskAndSkipsWorker() {
        when(model.available()).thenReturn(true);
        var existing = new ReviewStore.Task("existing", "RUNNING", null, null, null);
        when(store.submit(anyString())).thenReturn(new ReviewStore.Submission(existing, false));
        var tasks = new ReviewTasks(store, pubmed, model, engine, new ObjectMapper());
        try {
            assertEquals(existing, tasks.submit(" Question ", List.of("2", "1")));
            assertEquals(existing, tasks.submit("Question", List.of("1", "2", "2")));
            var fingerprint = org.mockito.ArgumentCaptor.forClass(String.class);
            verify(store, times(2)).submit(fingerprint.capture());
            assertEquals(fingerprint.getAllValues().get(0), fingerprint.getAllValues().get(1));
            verifyNoInteractions(pubmed, engine);
        } finally {
            tasks.close();
        }
    }

    @Test
    void persistsAsyncResultForVerifiedSources() throws Exception {
        when(model.available()).thenReturn(true);
        var task = new ReviewStore.Task("job", "QUEUED", null, null, null);
        var article = new Article("1", "Title", "Fixture", List.of(), null, null, null, null);
        when(store.submit(anyString())).thenReturn(new ReviewStore.Submission(task, true));
        when(store.start("job")).thenReturn(true);
        when(pubmed.fetch(List.of("1"))).thenReturn(List.of(article));
        when(engine.review("Question", List.of(article)))
            .thenReturn(new EvidenceEngine.Review(List.of(), List.of(), List.of(), List.of(), List.of()));
        var tasks = new ReviewTasks(store, pubmed, model, engine, new ObjectMapper());
        try {
            assertEquals("QUEUED", tasks.submit("Question", List.of("1")).state());
            verify(store, timeout(1500)).finish(eq("job"), eq("SUCCEEDED"),
                contains("\"findings\""), isNull(), isNull());
        } finally {
            tasks.close();
        }
    }
}
