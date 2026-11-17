package org.medevidence;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class ModelOutputTest {
    @Test
    void rejectsMalformedAndAmbiguousJsonAcrossTheHttpBoundary() throws Exception {
        var mapper = new ObjectMapper();
        var upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var response = new java.util.concurrent.atomic.AtomicReference<>("");
        upstream.createContext("/v1/chat/completions", exchange -> {
            try (exchange) {
                byte[] bytes = response.get().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            }
        });
        upstream.start();
        try {
            var client = new ModelClient(mapper,
                "http://127.0.0.1:" + upstream.getAddress().getPort() + "/v1", "mock-test-key",
                "mock", Duration.ofSeconds(2));
            for (String content : List.of("{", "{\"ready\":true,\"ready\":false}", "{\"ready\":true} {}")) {
                response.set(mapper.writeValueAsString(Map.of("choices",
                    List.of(Map.of("message", Map.of("content", content))))));
                assertEquals("AI_INVALID_RESPONSE", assertThrows(SearchProblem.class,
                    () -> client.ask("Test", Map.of())).code);
            }
            response.set("null");
            assertEquals("AI_INVALID_RESPONSE", assertThrows(SearchProblem.class,
                () -> client.ask("Test", Map.of())).code);
            response.set("{\"choices\":[{\"message\":{\"content\":\"{\\\"ready\\\":true}\"}}]}");
            assertDoesNotThrow(client::verifyConnection);
        } finally {
            upstream.stop(0);
        }
    }
}
