UPDATE user_feature_switches
SET switches = (switches - 'voiceIO') || jsonb_build_object('audioIO', switches->'voiceIO')
WHERE switches ? 'voiceIO';
