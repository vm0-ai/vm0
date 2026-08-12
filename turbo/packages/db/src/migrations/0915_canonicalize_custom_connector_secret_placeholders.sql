LOCK TABLE "org_custom_connectors" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  definition record;
  field_value jsonb;
  injection_entry record;
  field_count integer;
  distinct_field_count integer;
  secret_field_count integer;
  injection_count integer;
  distinct_injection_count integer;
  canonical_template text;
  canonical_template_length integer;
BEGIN
  FOR definition IN
    SELECT
      "connector"."id",
      "connector"."auth_mode",
      "connector"."fields",
      "connector"."header_injections",
      "connector"."query_injections"
    FROM "org_custom_connectors" AS "connector"
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements("connector"."header_injections")
        AS "entry"("injection")
      WHERE jsonb_typeof("entry"."injection" -> 'valueTemplate') = 'string'
        AND strpos(
          "entry"."injection" ->> 'valueTemplate',
          '{{secret}}'
        ) > 0
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements("connector"."query_injections")
        AS "entry"("injection")
      WHERE jsonb_typeof("entry"."injection" -> 'valueTemplate') = 'string'
        AND strpos(
          "entry"."injection" ->> 'valueTemplate',
          '{{secret}}'
        ) > 0
    )
  LOOP
    IF definition."auth_mode" <> 'manual' THEN
      RAISE EXCEPTION
        'Legacy Custom Connector template has non-manual auth mode: %',
        definition."id";
    END IF;

    IF jsonb_typeof(definition."fields") IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION
        'Legacy Custom Connector template has malformed fields: %',
        definition."id";
    END IF;

    FOR field_value IN
      SELECT "entry"."field"
      FROM jsonb_array_elements(definition."fields") AS "entry"("field")
    LOOP
      IF jsonb_typeof(field_value) IS DISTINCT FROM 'object'
        OR jsonb_typeof(field_value -> 'key') IS DISTINCT FROM 'string'
        OR (field_value ->> 'key') !~ '^[a-z][a-z0-9_]{0,63}$'
        OR jsonb_typeof(field_value -> 'label') IS DISTINCT FROM 'string'
        OR btrim(field_value ->> 'label') = ''
        OR char_length(field_value ->> 'label') > 128
        OR jsonb_typeof(field_value -> 'kind') IS DISTINCT FROM 'string'
        OR (field_value ->> 'kind') NOT IN ('secret', 'variable')
        OR jsonb_typeof(field_value -> 'required') IS DISTINCT FROM 'boolean'
        OR (
          field_value ? 'description'
          AND (
            jsonb_typeof(field_value -> 'description') IS DISTINCT FROM 'string'
            OR char_length(field_value ->> 'description') > 512
          )
        )
      THEN
        RAISE EXCEPTION
          'Legacy Custom Connector template has malformed field data: %',
          definition."id";
      END IF;
    END LOOP;

    SELECT
      count(*)::integer,
      count(DISTINCT "entry"."field" ->> 'key')::integer,
      count(*) FILTER (
        WHERE "entry"."field" ->> 'key' = 'secret'
          AND "entry"."field" ->> 'kind' = 'secret'
      )::integer
    INTO field_count, distinct_field_count, secret_field_count
    FROM jsonb_array_elements(definition."fields") AS "entry"("field");

    IF field_count <> distinct_field_count OR secret_field_count <> 1 THEN
      RAISE EXCEPTION
        'Legacy Custom Connector template has ambiguous secret field data: %',
        definition."id";
    END IF;

    FOR injection_entry IN
      SELECT
        'header'::text AS "kind",
        "entry"."position",
        "entry"."injection"
      FROM jsonb_array_elements(definition."header_injections") WITH ORDINALITY
        AS "entry"("injection", "position")
      UNION ALL
      SELECT
        'query'::text AS "kind",
        "entry"."position",
        "entry"."injection"
      FROM jsonb_array_elements(definition."query_injections") WITH ORDINALITY
        AS "entry"("injection", "position")
    LOOP
      IF jsonb_typeof(injection_entry."injection") IS DISTINCT FROM 'object'
        OR jsonb_typeof(
          injection_entry."injection" -> 'name'
        ) IS DISTINCT FROM 'string'
        OR char_length(injection_entry."injection" ->> 'name') NOT BETWEEN 1 AND 128
        OR (
          injection_entry."kind" = 'query'
          AND btrim(injection_entry."injection" ->> 'name') = ''
        )
        OR jsonb_typeof(
          injection_entry."injection" -> 'valueTemplate'
        ) IS DISTINCT FROM 'string'
        OR char_length(
          injection_entry."injection" ->> 'valueTemplate'
        ) NOT BETWEEN 1 AND 2048
      THEN
        RAISE EXCEPTION
          'Legacy Custom Connector template has malformed % injection at % position %',
          injection_entry."kind",
          definition."id",
          injection_entry."position";
      END IF;

      IF injection_entry."kind" = 'header'
        AND (injection_entry."injection" ->> 'name')
          !~ '^[A-Za-z][A-Za-z0-9-]*$'
      THEN
        RAISE EXCEPTION
          'Legacy Custom Connector template has invalid header name at % position %',
          definition."id",
          injection_entry."position";
      END IF;

      IF strpos(
        injection_entry."injection" ->> 'valueTemplate',
        '{{secret}}'
      ) > 0 THEN
        canonical_template := replace(
          injection_entry."injection" ->> 'valueTemplate',
          '{{secret}}',
          '{{secrets.secret}}'
        );
        -- Match JavaScript string length: supplementary code points use two UTF-16 code units.
        SELECT coalesce(
          sum(
            CASE
              WHEN octet_length("character"."value") = 4 THEN 2
              ELSE 1
            END
          ),
          0
        )::integer
        INTO canonical_template_length
        FROM regexp_split_to_table(canonical_template, '')
          AS "character"("value");

        IF canonical_template_length > 2048 THEN
          RAISE EXCEPTION
            'Legacy Custom Connector template exceeds canonical limit at % % position %',
            definition."id",
            injection_entry."kind",
            injection_entry."position";
        END IF;
      END IF;
    END LOOP;

    SELECT
      count(*)::integer,
      count(DISTINCT lower("entry"."injection" ->> 'name'))::integer
    INTO injection_count, distinct_injection_count
    FROM jsonb_array_elements(definition."header_injections")
      AS "entry"("injection");
    IF injection_count <> distinct_injection_count THEN
      RAISE EXCEPTION
        'Legacy Custom Connector template has duplicate header injections: %',
        definition."id";
    END IF;

    SELECT
      count(*)::integer,
      count(DISTINCT "entry"."injection" ->> 'name')::integer
    INTO injection_count, distinct_injection_count
    FROM jsonb_array_elements(definition."query_injections")
      AS "entry"("injection");
    IF injection_count <> distinct_injection_count THEN
      RAISE EXCEPTION
        'Legacy Custom Connector template has duplicate query injections: %',
        definition."id";
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

UPDATE "org_custom_connectors" AS "connector"
SET "header_injections" = (
  SELECT jsonb_agg(
    CASE
      WHEN strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
      THEN jsonb_set(
        "entry"."injection",
        '{valueTemplate}',
        to_jsonb(
          replace(
            "entry"."injection" ->> 'valueTemplate',
            '{{secret}}',
            '{{secrets.secret}}'
          )
        ),
        false
      )
      ELSE "entry"."injection"
    END
    ORDER BY "entry"."position"
  )
  FROM jsonb_array_elements("connector"."header_injections") WITH ORDINALITY
    AS "entry"("injection", "position")
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements("connector"."header_injections")
    AS "entry"("injection")
  WHERE strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
);--> statement-breakpoint

UPDATE "org_custom_connectors" AS "connector"
SET "query_injections" = (
  SELECT jsonb_agg(
    CASE
      WHEN strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
      THEN jsonb_set(
        "entry"."injection",
        '{valueTemplate}',
        to_jsonb(
          replace(
            "entry"."injection" ->> 'valueTemplate',
            '{{secret}}',
            '{{secrets.secret}}'
          )
        ),
        false
      )
      ELSE "entry"."injection"
    END
    ORDER BY "entry"."position"
  )
  FROM jsonb_array_elements("connector"."query_injections") WITH ORDINALITY
    AS "entry"("injection", "position")
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements("connector"."query_injections")
    AS "entry"("injection")
  WHERE strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
);--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "org_custom_connectors" AS "connector"
    CROSS JOIN LATERAL (
      SELECT "entry"."injection"
      FROM jsonb_array_elements("connector"."header_injections")
        AS "entry"("injection")
      UNION ALL
      SELECT "entry"."injection"
      FROM jsonb_array_elements("connector"."query_injections")
        AS "entry"("injection")
    ) AS "entry"
    WHERE jsonb_typeof("entry"."injection" -> 'valueTemplate') = 'string'
      AND strpos("entry"."injection" ->> 'valueTemplate', '{{secret}}') > 0
  ) THEN
    RAISE EXCEPTION
      'Legacy Custom Connector templates remain after canonicalization';
  END IF;
END
$$;
