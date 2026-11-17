package org.medevidence;

import org.springframework.http.HttpStatus;

final class SearchProblem extends RuntimeException {
    final HttpStatus status;
    final String code;
    final String retryAfter;

    SearchProblem(HttpStatus status, String code, String message) {
        this(status, code, message, null);
    }

    SearchProblem(HttpStatus status, String code, String message, String retryAfter) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
    }
}
