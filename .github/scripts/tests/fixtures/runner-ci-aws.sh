#!/usr/bin/env bash
# External S3 boundary backed by real files. Tests own the listing/timeline
# fixtures independently of the bytes that the production scripts publish.
set -euo pipefail
printf '%s\n' "$*" >>"$AWS_LOG"
[ "$1" = s3api ] || exit 2
operation=$2
shift 2
key="" prefix="" body="" destination="" token="" delete_payload=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --body) body=$2; shift 2 ;;
    --delete) delete_payload=${2#file://}; shift 2 ;;
    --continuation-token) token=$2; shift 2 ;;
    --endpoint-url|--bucket|--content-type|--cache-control|--if-none-match|--output|--range|--cli-connect-timeout|--cli-read-timeout|--max-items|--max-keys) shift 2 ;;
    --no-paginate) shift ;;
    --*) echo "unexpected option: $1" >&2; exit 2 ;;
    *) destination=$1; shift ;;
  esac
done
object="${AWS_STORE}/${key}"
case "$operation" in
  list-objects-v2)
    [ "${AWS_MODE:-}" != list-fail ] || exit 8
    jq --arg prefix "$prefix" '.Contents |= map(select(.Key | startswith($prefix)))' \
      "${AWS_STORE}/index${token}.json"
    ;;
  put-object)
    if [ "${AWS_MODE:-}" = put-fail ]; then
      echo 'request failed X-Amz-Signature=supersecret' >&2
      exit 9
    fi
    if [ -f "$object" ]; then echo PreconditionFailed >&2; exit 1; fi
    mkdir -p "$(dirname "$object")"
    cp "$body" "$object"
    printf '{}\n'
    ;;
  head-object)
    [ -f "$object" ] || exit 1
    case "${AWS_MODE:-}" in
      head-fail) exit 6 ;;
      malformed-head) printf 'not-json\n' ;;
      oversized-head) printf '{"ContentLength":67108865}\n' ;;
      size-mismatch) printf '{"ContentLength":1}\n' ;;
      *) printf '{"ContentLength":%s}\n' "$(stat -c '%s' "$object")" ;;
    esac
    ;;
  get-object)
    if [[ "$key" == runner-binaries/* ]] && [ "${AWS_MODE:-}" = get-fail ]; then exit 7; fi
    [ "${AWS_MODE:-}" != record-get-fail ] || exit 7
    cp "$object" "$destination"
    printf '{}\n'
    ;;
  delete-objects)
    if [ "${AWS_MODE:-}" = partial-delete ]; then
      printf '{"Errors":[{"Code":"AccessDenied"}]}\n'
    else
      while IFS= read -r key; do rm "${AWS_STORE}/${key}"; done < <(jq -r '.Objects[].Key' "$delete_payload")
      printf '{}\n'
    fi
    ;;
  *) exit 2 ;;
esac
