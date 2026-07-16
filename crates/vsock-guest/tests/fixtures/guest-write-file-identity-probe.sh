#!/bin/sh
set -eu

target=""
after_separator=false
for argument in "$@"; do
  if [ "$after_separator" = true ]; then
    target=$argument
    break
  fi
  if [ "$argument" = "--" ]; then
    after_separator=true
  fi
done

if [ -z "$target" ]; then
  echo "identity probe requires -- <target>" >&2
  exit 1
fi

cat >/dev/null
{
  printf 'uid=%s\n' "$(id -u)"
  printf 'gid=%s\n' "$(id -g)"
  printf 'groups=%s\n' "$(id -G)"
  printf 'cwd=%s\n' "$(pwd -P)"
  printf 'home=%s\n' "${HOME-}"
  printf 'user=%s\n' "${USER-}"
  printf 'logname=%s\n' "${LOGNAME-}"
} >"$target"
