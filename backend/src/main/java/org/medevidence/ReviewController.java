package org.medevidence;

import java.util.List;
import java.util.UUID;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@CrossOrigin(origins = "${app.frontend-origin}")
@RequestMapping("/api")
final class ReviewController {
    record ReviewRequest(String question, List<String> pmids) {}
    record Capabilities(boolean semantic, boolean review) {}
    private final ReviewTasks tasks;
    private final ReviewStore store;
    private final ModelClient model;

    ReviewController(ReviewTasks tasks, ReviewStore store, ModelClient model) {
        this.tasks = tasks;
        this.store = store;
        this.model = model;
    }

    @GetMapping("/capabilities")
    ApiResponse capabilities() {
        return new ApiResponse("OK", "功能配置", new Capabilities(model.available(), model.available() && store.configured()));
    }

    @PostMapping("/reviews")
    ResponseEntity<ApiResponse> submit(@RequestBody ReviewRequest request) {
        var task = tasks.submit(request.question(), request.pmids());
        return ResponseEntity.status(task.state().equals("SUCCEEDED") ? HttpStatus.OK : HttpStatus.ACCEPTED)
            .body(new ApiResponse("OK", "综述任务已受理。", task));
    }

    @GetMapping("/reviews/{id}")
    ApiResponse get(@PathVariable UUID id) {
        return new ApiResponse("OK", "综述任务状态", store.get(id.toString()));
    }
}
