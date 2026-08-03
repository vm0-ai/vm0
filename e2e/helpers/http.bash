#!/usr/bin/env bash

e2e_curl() {
    curl -fsS \
        --connect-timeout "${E2E_CURL_CONNECT_TIMEOUT_SECONDS:-10}" \
        --max-time "${E2E_CURL_MAX_TIME_SECONDS:-30}" \
        "$@"
}
