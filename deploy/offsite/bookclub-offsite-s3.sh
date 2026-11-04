#!/usr/bin/env bash
# A second, independent offsite copy of the incremental backup set (D125, D129), in S3 (or any
# S3-compatible store), beside whatever backup the host itself has (docs/DEPLOY.md). Run by bookclub-offsite-s3.timer after
# the daily backup, as the deploy user (same one that owns the backup directory). Syncs:
#
#   BOOKCLUB_BACKUPS/db/...    -> s3://BUCKET/PREFIX/daily/    (a lifecycle rule expires these by age)
#   BOOKCLUB_BACKUPS/files/... -> s3://BUCKET/PREFIX/files/    (content-addressed: sync is incremental)
#
# Never passes --delete: the AWS identity this runs as (BOOKCLUB_OFFSITE_AWS) is deliberately not
# granted s3:DeleteObject (docs/DEPLOY.md, "Offsite copy (S3)"), so a bug here cannot remove what is
# already safely offsite. It is safe to run on any schedule, even mid a backup run: it only ever
# uploads files the backup already renamed into place (bookclub-set.ts never leaves a *.partial
# file where this would find it), never a file still being written.
#
# Fails loudly (non-zero exit, a line in the journal via logger) and never touches local data.
set -euo pipefail

: "${BOOKCLUB_BACKUPS:?set to the backup set directory, e.g. /opt/book-club/deploy/backups}"
: "${BOOKCLUB_OFFSITE_BUCKET:?set to the S3 bucket name (docs/DEPLOY.md, \"Offsite copy (S3)\")}"
BOOKCLUB_OFFSITE_PREFIX=${BOOKCLUB_OFFSITE_PREFIX:-book-club}
# The AWS CLI to run, as a command with arguments: "aws --profile book-club-offsite", a wrapper
# that fetches the host's own credentials first, or "aws --endpoint-url https://..." for another
# S3-compatible store (split on whitespace below: every piece is one token, no further quoting).
BOOKCLUB_OFFSITE_AWS=${BOOKCLUB_OFFSITE_AWS:-aws}
read -r -a AWS <<<"$BOOKCLUB_OFFSITE_AWS"
# A recent AWS CLI defaults PutObject to an "aws-chunked" body with a trailing checksum
# (AWS_REQUEST_CHECKSUM_CALCULATION=when_supported); some S3-compatible stores (older MinIO, a
# local test double) store that wire envelope as the object's bytes instead of decoding it,
# corrupting every upload. Real S3 handles it, but there is nothing to gain from it here (this
# never uploads a partial or resumed object), so it is turned off for every target.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required

log() {
  echo "bookclub-offsite-s3: $*" >&2
  command -v logger >/dev/null && logger -t bookclub-offsite-s3 -- "$*" || true
}

[[ -d "$BOOKCLUB_BACKUPS/db" ]] || {
  log "no $BOOKCLUB_BACKUPS/db: has the backup service made its first snapshot yet?"
  exit 1
}

DEST="s3://${BOOKCLUB_OFFSITE_BUCKET}/${BOOKCLUB_OFFSITE_PREFIX}"
ok=1

if ! "${AWS[@]}" s3 sync --only-show-errors "$BOOKCLUB_BACKUPS/db/" "$DEST/daily/"; then
  log "sync of db/ to $DEST/daily/ failed"
  ok=0
fi
if [[ -d "$BOOKCLUB_BACKUPS/files" ]] && ! "${AWS[@]}" s3 sync --only-show-errors "$BOOKCLUB_BACKUPS/files/" "$DEST/files/"; then
  log "sync of files/ to $DEST/files/ failed"
  ok=0
fi

if [[ "$ok" != 1 ]]; then
  log "offsite sync to $DEST failed (see above); local backups are untouched; the next timer run tries again"
  exit 1
fi
log "offsite sync to $DEST done"
