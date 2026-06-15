CREATE UNIQUE INDEX "idx_compose_jobs_user_active" ON "compose_jobs" USING btree ("user_id") WHERE status IN ('pending', 'running');
