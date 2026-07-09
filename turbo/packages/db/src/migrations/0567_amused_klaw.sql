CREATE TABLE "user_artifact_favorites" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"artifact_url" text NOT NULL,
	CONSTRAINT "user_artifact_favorites_org_id_user_id_artifact_url_pk" PRIMARY KEY("org_id","user_id","artifact_url")
);
