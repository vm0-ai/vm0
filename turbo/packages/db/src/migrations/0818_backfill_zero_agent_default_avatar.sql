-- Agents created through the CLI/API without an explicit avatar were stored
-- with a NULL avatar_url and render with no avatar at all. Give each of them
-- one of the built-in preset avatars (preset:0 .. preset:4).
UPDATE "zero_agents"
SET "avatar_url" = 'preset:' || floor(random() * 5)::int
WHERE "avatar_url" IS NULL;
