package org.medevidence;

import org.springframework.http.*;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
final class ApiErrors {
    @ExceptionHandler(SearchProblem.class)
    ResponseEntity<ApiResponse> searchError(SearchProblem problem) {
        var response = ResponseEntity.status(problem.status);
        if (problem.retryAfter != null) response.header("Retry-After", problem.retryAfter);
        return response.body(new ApiResponse(problem.code, problem.getMessage(), null));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<ApiResponse> invalidBody() {
        return ResponseEntity.badRequest().body(new ApiResponse("INVALID_REQUEST", "请求参数或 JSON 格式不正确。", null));
    }
}
