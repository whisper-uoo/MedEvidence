package org.medevidence;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ModelSettingsTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void exposesOnlySafeStatusAndMissingVariableNames() throws Exception {
        var model = new ModelClient(json, "http://127.0.0.1:9999/v1",
            "test-private-model-value", "test-private-model-name", Duration.ofSeconds(1));
        var store = new ReviewStore("", "", "test-private-db-value", json);
        var controller = new ReviewController(null, store, model);
        var request = mock(HttpServletRequest.class);
        when(request.getRemoteAddr()).thenReturn("127.0.0.1");

        var response = controller.modelStatus(request);
        assertEquals("no-store", response.getHeaders().getCacheControl());
        String body = json.writeValueAsString(response.getBody());
        assertTrue(body.contains("UNCONFIGURED"));
        assertFalse(body.contains("test-private"));
        assertFalse(body.contains("9999"));
        var incomplete = new ModelClient(json, "", "", "", Duration.ofSeconds(1));
        assertEquals(List.of("AI_BASE_URL", "AI_MODEL", "AI_API_KEY"), incomplete.missingSettings());
    }

    @Test
    void refusesRemoteStatusAndProbeBeforeContactingDependencies() {
        var model = mock(ModelClient.class);
        var store = mock(ReviewStore.class);
        var controller = new ReviewController(null, store, model);
        var request = mock(HttpServletRequest.class);
        when(request.getRemoteAddr()).thenReturn("192.0.2.10");

        assertEquals(403, assertThrows(SearchProblem.class, () -> controller.modelStatus(request)).status.value());
        assertEquals(403, assertThrows(SearchProblem.class, () -> controller.testModel(request)).status.value());
        verifyNoInteractions(model, store);
    }
}
