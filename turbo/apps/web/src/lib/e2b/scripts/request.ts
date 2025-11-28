/**
 * Unified HTTP request functions for agent scripts
 * Provides curl wrapper with retry logic and Vercel bypass support
 */
export const REQUEST_SCRIPT = `# Unified HTTP request functions
# Requires: LOG_SCRIPT to be sourced first

# HTTP POST with JSON body and retry logic
# Usage: http_post_json <url> <json_data> [max_retries]
# Returns: 0 on success, 1 on failure
# Outputs: Response body on stdout
http_post_json() {
  local url="$1"
  local data="$2"
  local max_retries="\${3:-$HTTP_MAX_RETRIES}"
  local attempt=1
  local response
  local curl_exit

  while [ $attempt -le $max_retries ]; do
    log_debug "HTTP POST attempt $attempt/$max_retries to $url"

    if [ -n "$VERCEL_BYPASS" ]; then
      response=$(curl -X POST "$url" \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer $API_TOKEN" \\
        -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \\
        -d "$data" \\
        --connect-timeout "$HTTP_CONNECT_TIMEOUT" \\
        --max-time "$HTTP_MAX_TIME" \\
        --silent --fail 2>&1)
      curl_exit=$?
    else
      response=$(curl -X POST "$url" \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer $API_TOKEN" \\
        -d "$data" \\
        --connect-timeout "$HTTP_CONNECT_TIMEOUT" \\
        --max-time "$HTTP_MAX_TIME" \\
        --silent --fail 2>&1)
      curl_exit=$?
    fi

    if [ $curl_exit -eq 0 ]; then
      echo "$response"
      return 0
    fi

    log_warn "HTTP POST failed (attempt $attempt/$max_retries): exit code $curl_exit"

    if [ $attempt -lt $max_retries ]; then
      sleep 1
    fi

    attempt=$((attempt + 1))
  done

  log_error "HTTP POST failed after $max_retries attempts to $url"
  return 1
}

# HTTP POST with form data and retry logic
# Usage: http_post_form <url> [max_retries] -F "field=value" ...
# Returns: 0 on success, 1 on failure
# Outputs: Response body on stdout
http_post_form() {
  local url="$1"
  local max_retries="\${2:-$HTTP_MAX_RETRIES}"
  shift 2

  local attempt=1
  local response
  local curl_exit

  while [ $attempt -le $max_retries ]; do
    log_debug "HTTP POST form attempt $attempt/$max_retries to $url"

    if [ -n "$VERCEL_BYPASS" ]; then
      response=$(curl -X POST "$url" \\
        -H "Authorization: Bearer $API_TOKEN" \\
        -H "x-vercel-protection-bypass: $VERCEL_BYPASS" \\
        "$@" \\
        --connect-timeout "$HTTP_CONNECT_TIMEOUT" \\
        --max-time "$HTTP_MAX_TIME_UPLOAD" \\
        --silent 2>&1)
      curl_exit=$?
    else
      response=$(curl -X POST "$url" \\
        -H "Authorization: Bearer $API_TOKEN" \\
        "$@" \\
        --connect-timeout "$HTTP_CONNECT_TIMEOUT" \\
        --max-time "$HTTP_MAX_TIME_UPLOAD" \\
        --silent 2>&1)
      curl_exit=$?
    fi

    if [ $curl_exit -eq 0 ]; then
      echo "$response"
      return 0
    fi

    log_warn "HTTP POST form failed (attempt $attempt/$max_retries): exit code $curl_exit"

    if [ $attempt -lt $max_retries ]; then
      sleep 1
    fi

    attempt=$((attempt + 1))
  done

  log_error "HTTP POST form failed after $max_retries attempts to $url"
  return 1
}
`;
