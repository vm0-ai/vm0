-- Add selected_model column to model_providers table
-- For providers with model selection (e.g., Moonshot), stores the user's chosen model
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "selected_model" varchar(255);
