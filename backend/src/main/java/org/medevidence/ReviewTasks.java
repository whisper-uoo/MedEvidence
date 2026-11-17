package org.medevidence;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.concurrent.*;
import org.slf4j.*;
import org.springframework.stereotype.Service;
import static org.springframework.http.HttpStatus.*;

@Service
final class ReviewTasks {
    private static final Logger log = LoggerFactory.getLogger(ReviewTasks.class);
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(2));
    private final ReviewStore store;
    private final PubMedClient pubmed;
    private final ModelClient model;
    private final EvidenceEngine engine;
    private final ObjectMapper json;

    ReviewTasks(ReviewStore store, PubMedClient pubmed, ModelClient model, EvidenceEngine engine, ObjectMapper json) {
        this.store = store;
        this.pubmed = pubmed;
        this.model = model;
        this.engine = engine;
        this.json = json;
    }

    ReviewStore.Task submit(String question, List<String> pmids) {
        if (question == null || question.isBlank() || question.length() > 1000 || pmids == null || pmids.isEmpty()
            || pmids.size() > 10 || pmids.stream().anyMatch(id -> id == null || !id.matches("[1-9][0-9]{0,11}"))) {
            throw new SearchProblem(BAD_REQUEST, "INVALID_REVIEW", "请填写研究问题并选择 1–10 篇有效文献。");
        }
        if (!model.available()) throw new SearchProblem(SERVICE_UNAVAILABLE, "AI_UNAVAILABLE", "尚未配置模型服务。");

        var ids = pmids.stream().distinct().sorted().toList();
        String normalized = question.strip();
        var submission = store.submit(fingerprint(normalized, ids), normalized, ids);
        var task = submission.task();
        if (submission.created()) {
            try {
                workers.execute(() -> execute(task.id(), normalized, ids));
            } catch (RejectedExecutionException ex) {
                store.finish(task.id(), "FAILED", null, "REVIEW_BUSY", "综述任务队列已满，请稍后重试。");
                throw new SearchProblem(SERVICE_UNAVAILABLE, "REVIEW_BUSY", "综述任务队列已满，请稍后重试。");
            }
        }
        return task;
    }

    private void execute(String id, String question, List<String> ids) {
        try {
            if (!store.start(id)) return;
            var articles = pubmed.fetch(ids);
            if (articles.size() != ids.size()) {
                throw new SearchProblem(UNPROCESSABLE_ENTITY, "SOURCE_MISSING", "PubMed 未返回所有选中的文献。");
            }
            var review = engine.review(question, articles);
            store.finish(id, "SUCCEEDED", json.writeValueAsString(review), null, null);
        } catch (SearchProblem ex) {
            fail(id, ex.status == GATEWAY_TIMEOUT ? "TIMED_OUT" : "FAILED", ex.code, ex.getMessage());
        } catch (Exception ex) {
            fail(id, "FAILED", "REVIEW_FAILED", "综述任务失败。");
        }
    }

    private void fail(String id, String state, String code, String message) {
        log.warn("Review task {} ended with {}", id, code);
        try {
            store.finish(id, state, null, code, message);
        } catch (SearchProblem ex) {
            log.warn("Unable to save review task {}: {}", id, ex.code);
        }
    }

    private String fingerprint(String question, List<String> ids) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256")
                .digest(("evidence-v2\n" + question + "\n" + String.join(",", ids)).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    @PreDestroy
    void close() {
        workers.shutdownNow();
    }
}
