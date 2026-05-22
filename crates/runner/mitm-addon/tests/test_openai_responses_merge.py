"""Tests for merging OpenAI Responses usage extraction results."""

from usage import merge_openai_responses_usage_result


def test_merge_copies_model_and_message_id():
    target = {}
    source = {
        "model": "gpt-5.5",
        "message_id": "resp_1",
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "model": "gpt-5.5",
        "message_id": "resp_1",
    }


def test_merge_ignores_empty_model_and_message_id():
    target = {
        "model": "gpt-5.5",
        "message_id": "resp_1",
    }
    source = {
        "model": "",
        "message_id": "",
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "model": "gpt-5.5",
        "message_id": "resp_1",
    }


def test_merge_allows_positive_tokens_to_replace_prior():
    target = {
        "tokens.input": 50,
        "tokens.output": 20,
    }
    source = {
        "tokens.input": 100,
        "tokens.output": 40,
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "tokens.input": 100,
        "tokens.output": 40,
    }


def test_merge_preserves_existing_positive_tokens_when_source_is_zero():
    target = {
        "tokens.input": 100,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }
    source = {
        "tokens.input": 0,
        "tokens.output": 0,
        "tokens.cache_read": 0,
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "tokens.input": 100,
        "tokens.output": 40,
        "tokens.cache_read": 25,
    }


def test_merge_allows_zero_to_initialize_when_absent():
    target = {}
    source = {
        "tokens.input": 0,
        "tokens.output": 0,
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "tokens.input": 0,
        "tokens.output": 0,
    }


def test_merge_only_applies_openai_categories():
    target = {
        "tokens.cache_creation": 15,
    }
    source = {
        "tokens.input": 50,
        "tokens.cache_creation": 99,  # Non-OpenAI category, should be ignored by the merge
    }
    merge_openai_responses_usage_result(target, source)
    assert target == {
        "tokens.input": 50,
        "tokens.cache_creation": 15,  # Preserved, not overwritten or updated by Anthropic specific key in source
    }
