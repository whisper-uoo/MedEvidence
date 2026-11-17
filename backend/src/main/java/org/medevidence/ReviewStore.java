package org.medevidence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.*;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;
import static org.springframework.http.HttpStatus.*;

@Repository
final class ReviewStore {
    record Task(String id, String state, JsonNode result, String errorCode, String message) {}
    record Submission(Task task, boolean created) {}

    private final String url;
    private final String username;
    private final String password;
    private final ObjectMapper json;

    ReviewStore(@Value("${review.db-url:}") String url, @Value("${review.db-user:}") String username,
                @Value("${review.db-password:}") String password, ObjectMapper json) {
        this.url = url;
        this.username = username;
        this.password = password;
        this.json = json;
    }

    boolean configured() {
        return !url.isBlank() && !username.isBlank();
    }

    Submission submit(String fingerprint) {
        String id = UUID.randomUUID().toString();
        try (var db = connection()) {
            expire(db);
            try (var sql = db.prepareStatement("""
                INSERT INTO review_tasks (id, fingerprint, state, deadline)
                VALUES (?, ?, 'QUEUED', TIMESTAMPADD(SECOND, 150, CURRENT_TIMESTAMP(6)))
                """)) {
                sql.setString(1, id);
                sql.setString(2, fingerprint);
                sql.executeUpdate();
                return new Submission(new Task(id, "QUEUED", null, null, null), true);
            } catch (SQLIntegrityConstraintViolationException duplicate) {
                Task existing = find(db, "fingerprint", fingerprint);
                if (existing == null) {
                    // The previous task released its fingerprint after the duplicate insert.
                    throw new SearchProblem(CONFLICT, "REVIEW_RETRY", "前一个任务刚结束，请重新提交。");
                }
                return new Submission(existing, false);
            }
        } catch (SQLException ex) {
            throw dbError(ex);
        }
    }

    Task get(String id) {
        try (var db = connection()) {
            expire(db);
            Task task = find(db, "id", id);
            if (task == null) throw new SearchProblem(NOT_FOUND, "TASK_NOT_FOUND", "找不到该综述任务。");
            return task;
        } catch (SQLException ex) {
            throw dbError(ex);
        }
    }

    boolean start(String id) {
        try (var db = connection(); var sql = db.prepareStatement("""
            UPDATE review_tasks SET state = 'RUNNING' WHERE id = ? AND state = 'QUEUED'
              AND deadline > CURRENT_TIMESTAMP(6)
            """)) {
            sql.setString(1, id);
            return sql.executeUpdate() == 1;
        } catch (SQLException ex) {
            throw dbError(ex);
        }
    }

    void finish(String id, String state, String result, String code, String message) {
        try (var db = connection(); var sql = db.prepareStatement("""
            UPDATE review_tasks SET state = ?, result = ?, error_code = ?, message = ?,
                fingerprint = IF(? = 'SUCCEEDED', fingerprint, NULL)
            WHERE id = ? AND state IN ('QUEUED', 'RUNNING') AND deadline > CURRENT_TIMESTAMP(6)
            """)) {
            sql.setString(1, state);
            sql.setString(2, result);
            sql.setString(3, code);
            sql.setString(4, message);
            sql.setString(5, state);
            sql.setString(6, id);
            sql.executeUpdate();
        } catch (SQLException ex) {
            throw dbError(ex);
        }
    }

    private Connection connection() throws SQLException {
        if (!configured()) throw new SearchProblem(SERVICE_UNAVAILABLE, "REVIEW_DB_UNAVAILABLE", "尚未配置综述数据库。");
        var properties = new java.util.Properties();
        properties.setProperty("user", username);
        properties.setProperty("password", password);
        properties.setProperty("connectTimeout", "3000");
        properties.setProperty("socketTimeout", "5000");
        return DriverManager.getConnection(url, properties);
    }

    private void expire(Connection db) throws SQLException {
        try (var sql = db.prepareStatement("""
            UPDATE review_tasks SET state = 'TIMED_OUT', error_code = 'REVIEW_TIMEOUT',
                message = '综述任务超过时限或服务已重启。', fingerprint = NULL
            WHERE state IN ('QUEUED', 'RUNNING') AND deadline <= CURRENT_TIMESTAMP(6)
            """)) {
            sql.executeUpdate();
        }
    }

    private Task find(Connection db, String column, String value) throws SQLException {
        try (var sql = db.prepareStatement("""
            SELECT id, state, result, error_code, message FROM review_tasks WHERE
            """ + " " + column + " = ?")) {
            sql.setString(1, value);
            try (var rows = sql.executeQuery()) {
                if (!rows.next()) return null;
                String result = rows.getString("result");
                return new Task(rows.getString("id"), rows.getString("state"),
                    result == null ? null : json.readTree(result), rows.getString("error_code"),
                    rows.getString("message"));
            } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
                throw new SQLException("Invalid saved review result", ex);
            }
        }
    }

    private SearchProblem dbError(SQLException ex) {
        org.slf4j.LoggerFactory.getLogger(getClass()).warn("Review database failed (SQLState {}, code {})",
            ex.getSQLState(), ex.getErrorCode());
        return new SearchProblem(SERVICE_UNAVAILABLE, "REVIEW_DB_ERROR", "综述数据库不可用，请检查连接和迁移。");
    }
}
