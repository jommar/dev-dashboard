#!/bin/sh
# git credential helper: serves GH_TOKEN (or GITHUB_TOKEN) for github.com, so
# `git fetch` in the mounted sibling repos can authenticate without host config.
[ "$1" = get ] || exit 0
token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
[ -n "$token" ] || exit 0
printf 'username=x-access-token\npassword=%s\n' "$token"
