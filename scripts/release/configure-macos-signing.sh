#!/usr/bin/env bash
# Decides how a macOS release build is signed and notarized, from secrets that
# may or may not exist, and exports to the following GitHub Actions steps only
# the variables of complete groups. Tauri treats a variable that is present
# but empty as configured (e.g. it tries to import an empty APPLE_CERTIFICATE),
# so absent secrets must not be exported at all.
#
# Groups (all-or-nothing; a partial group is a configuration error):
#   Developer ID signing : APPLE_CERTIFICATE (base64 .p12), APPLE_CERTIFICATE_PASSWORD,
#                          APPLE_SIGNING_IDENTITY
#   Notarization (key)   : APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_P8 (.p8 contents)
#   Notarization (login) : APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID
# With no signing group the build is ad-hoc signed (tauri.conf.json
# `signingIdentity: "-"`), which runs on Apple Silicon but is not trusted by
# Gatekeeper. REQUIRE_SIGNED=true turns "not signed and notarized" into an error.
#
# Writes: $GITHUB_ENV (variables), $GITHUB_OUTPUT (signed=, notarized=).
set -euo pipefail

: "${GITHUB_ENV:?GITHUB_ENV is not set (run inside GitHub Actions)}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set (run inside GitHub Actions)}"

# Counts how many of the named variables are non-empty.
count_present() {
  local n=0 name
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      n=$((n + 1))
    fi
  done
  echo "$n"
}

# Classifies a group: none | complete | partial.
group_state() {
  local present
  present="$(count_present "$@")"
  if [ "$present" -eq 0 ]; then
    echo none
  elif [ "$present" -eq "$#" ]; then
    echo complete
  else
    echo partial
  fi
}

export_var() {
  local name="$1" value="$2" delimiter
  delimiter="EOF_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  {
    echo "$name<<$delimiter"
    printf '%s\n' "$value"
    echo "$delimiter"
  } >>"$GITHUB_ENV"
}

SIGN_STATE="$(group_state APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY)"
KEY_STATE="$(group_state APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_P8)"
LOGIN_STATE="$(group_state APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)"

for pair in "signing:$SIGN_STATE" "notarization-api-key:$KEY_STATE" "notarization-apple-id:$LOGIN_STATE"; do
  if [ "${pair#*:}" = "partial" ]; then
    echo "::error::macOS ${pair%%:*} secrets are only partly configured; set all of them or none (see docs/reports/revamp-2026-10-26/release.md)."
    exit 1
  fi
done

SIGNED=false
NOTARIZED=false

if [ "$SIGN_STATE" = "complete" ]; then
  export_var APPLE_CERTIFICATE "$APPLE_CERTIFICATE"
  export_var APPLE_CERTIFICATE_PASSWORD "$APPLE_CERTIFICATE_PASSWORD"
  export_var APPLE_SIGNING_IDENTITY "$APPLE_SIGNING_IDENTITY"
  SIGNED=true
  echo "macOS signing: Developer ID ($APPLE_SIGNING_IDENTITY)"
else
  echo "::warning::macOS signing secrets are not configured; this build is ad-hoc signed and will not pass Gatekeeper on download."
fi

if [ "$SIGNED" = "true" ]; then
  if [ "$KEY_STATE" = "complete" ]; then
    KEY_PATH="${RUNNER_TEMP:-/tmp}/AuthKey_${APPLE_API_KEY}.p8"
    (umask 077 && printf '%s\n' "$APPLE_API_KEY_P8" >"$KEY_PATH")
    export_var APPLE_API_ISSUER "$APPLE_API_ISSUER"
    export_var APPLE_API_KEY "$APPLE_API_KEY"
    export_var APPLE_API_KEY_PATH "$KEY_PATH"
    NOTARIZED=true
    echo "macOS notarization: App Store Connect API key"
  elif [ "$LOGIN_STATE" = "complete" ]; then
    export_var APPLE_ID "$APPLE_ID"
    export_var APPLE_PASSWORD "$APPLE_PASSWORD"
    export_var APPLE_TEAM_ID "$APPLE_TEAM_ID"
    NOTARIZED=true
    echo "macOS notarization: Apple ID"
  else
    echo "::warning::macOS notarization secrets are not configured; the signed build will not be notarized."
  fi
elif [ "$KEY_STATE" = "complete" ] || [ "$LOGIN_STATE" = "complete" ]; then
  echo "::warning::macOS notarization secrets are set but signing secrets are not; notarization needs a Developer ID signature and is skipped."
fi

if [ "${REQUIRE_SIGNED:-false}" = "true" ] && { [ "$SIGNED" != "true" ] || [ "$NOTARIZED" != "true" ]; }; then
  echo "::error::OPENLINEAR_REQUIRE_SIGNED_RELEASE=true but this build would not be signed and notarized."
  exit 1
fi

echo "signed=$SIGNED" >>"$GITHUB_OUTPUT"
echo "notarized=$NOTARIZED" >>"$GITHUB_OUTPUT"
