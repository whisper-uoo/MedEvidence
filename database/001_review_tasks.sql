CREATE TABLE IF NOT EXISTS review_tasks (
    id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
    fingerprint CHAR(64) CHARACTER SET ascii NULL UNIQUE,
    state VARCHAR(16) NOT NULL,
    result JSON NULL,
    error_code VARCHAR(64) NULL,
    message VARCHAR(500) NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    deadline TIMESTAMP(6) NOT NULL,
    INDEX review_tasks_deadline (state, deadline)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
