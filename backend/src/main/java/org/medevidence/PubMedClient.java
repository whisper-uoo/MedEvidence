package org.medevidence;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import static org.springframework.http.HttpStatus.*;

@Component
final class PubMedClient {
    private final URI base;
    private final Duration timeout;
    private final String credentials;
    private final HttpClient http;
    private final PubMedXml xml = new PubMedXml();
    private final java.util.concurrent.Semaphore slots = new java.util.concurrent.Semaphore(6);
    private long lastRequest = System.nanoTime() - 350_000_000L;

    PubMedClient(@Value("${pubmed.base-url}") URI base,
                 @Value("${pubmed.timeout}") Duration timeout,
                 @Value("${pubmed.email}") String email,
                 @Value("${pubmed.api-key}") String apiKey) {
        this.base = base;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(timeout).build();
        this.credentials = "&tool=MedEvidence"
            + (email.isBlank() ? "" : "&email=" + encode(email))
            + (apiKey.isBlank() ? "" : "&api_key=" + encode(apiKey));
    }

    record Page(long total, List<Article> articles) {}

    Page search(String query, int limit, int offset) {
        var matches = xml.matches(get("esearch.fcgi", "&retmode=xml&sort=relevance&retmax="
            + limit + "&retstart=" + offset + "&term=" + encode(query)));
        if (matches.ids().isEmpty()) {
            if (matches.total() > offset) throw PubMedXml.invalidResponse();
            return new Page(matches.total(), List.of());
        }
        var articles = fetch(matches.ids());
        if (articles.isEmpty()) {
            throw PubMedXml.invalidResponse();
        }
        return new Page(matches.total(), articles);
    }

    List<Article> fetch(List<String> ids) {
        var byId = xml.articles(get("efetch.fcgi", "&retmode=xml&id=" + encode(String.join(",", ids))))
            .stream().collect(Collectors.toMap(Article::pmid, article -> article, (first, duplicate) -> first));
        return ids.stream().distinct().map(byId::get).filter(Objects::nonNull).toList();
    }

    private ByteArrayInputStream get(String endpoint, String parameters) {
        var request = HttpRequest.newBuilder(base.resolve(endpoint + "?db=pubmed" + credentials + parameters))
            .timeout(timeout).GET().build();
        if (!slots.tryAcquire()) {
            throw new SearchProblem(SERVICE_UNAVAILABLE, "PUBMED_BUSY", "检索服务繁忙，请稍后重试。");
        }
        try {
            var response = send(request);
            if (response.statusCode() == 429) {
                throw new SearchProblem(SERVICE_UNAVAILABLE, "PUBMED_RATE_LIMITED", "PubMed 请求受限，请稍后重试。",
                    response.headers().firstValue("Retry-After").orElse(null));
            }
            if (response.statusCode() != 200) {
                throw new SearchProblem(BAD_GATEWAY, "PUBMED_HTTP_ERROR", "PubMed 返回异常状态。");
            }
            return new ByteArrayInputStream(response.body());
        } catch (HttpTimeoutException ex) {
            throw new SearchProblem(GATEWAY_TIMEOUT, "PUBMED_TIMEOUT", "PubMed 响应超时。");
        } catch (IOException ex) {
            throw new SearchProblem(BAD_GATEWAY, "PUBMED_NETWORK_ERROR", "无法连接 PubMed。");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new SearchProblem(SERVICE_UNAVAILABLE, "REQUEST_INTERRUPTED", "检索被中断，请重试。");
        } finally {
            slots.release();
        }
    }

    private HttpResponse<byte[]> send(HttpRequest request) throws IOException, InterruptedException {
        java.util.concurrent.CompletableFuture<HttpResponse<byte[]>> pending;
        synchronized (this) {
            long delay = 350_000_000L - (System.nanoTime() - lastRequest);
            if (delay > 0) {
                java.util.concurrent.TimeUnit.NANOSECONDS.sleep(delay);
            }
            lastRequest = System.nanoTime();
            pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
        }
        try {
            return pending.get(timeout.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException ex) {
            pending.cancel(true);
            throw new HttpTimeoutException("PubMed timed out");
        } catch (java.util.concurrent.ExecutionException ex) {
            if (ex.getCause() instanceof HttpTimeoutException timeoutError) {
                throw timeoutError;
            }
            throw new IOException(ex.getCause());
        } catch (InterruptedException ex) {
            pending.cancel(true);
            throw ex;
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
