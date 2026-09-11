-- Enforce withdrawal for every writer, including API versions deployed before
-- purpose epochs existed. Epochs are never restored on a later opt-in.
CREATE FUNCTION invalidate_marketing_privacy_epochs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM 'explicit'
     OR NEW.sale_sharing <> 'granted' OR NEW.advertising <> 'granted'
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
    NEW.advertising_epoch := gen_random_uuid();
  END IF;
  IF NEW.source IS DISTINCT FROM 'explicit'
     OR NEW.sale_sharing <> 'granted' OR NEW.marketing_analytics <> 'granted'
     OR NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
    NEW.marketing_analytics_epoch := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER marketing_privacy_withdrawal
BEFORE UPDATE ON privacy_choices FOR EACH ROW
EXECUTE FUNCTION invalidate_marketing_privacy_epochs();
