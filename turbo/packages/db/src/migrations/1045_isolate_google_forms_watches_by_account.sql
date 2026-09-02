CREATE UNIQUE INDEX "idx_google_forms_watch_states_connector_form" ON "google_forms_watch_states" USING btree ("connector_id","form_id");
