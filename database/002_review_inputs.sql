-- Apply once after 001, including on a fresh database.
ALTER TABLE review_tasks
    ADD COLUMN question VARCHAR(1000) NULL,
    ADD COLUMN pmids JSON NULL;
