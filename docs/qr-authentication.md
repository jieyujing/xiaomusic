# QR login and speaker authentication

The settings page previously treated a successful Mijia QR-session refresh as
proof of speaker login. Production reproduced `already_logged_in=true` with an
empty speaker device list twice. Two authentication files for the same account
had diverged: the container-home file could authenticate `micoapi` and list one
LX06; the persistent configuration file returned Xiaomi code `70016`.
Restoring the verified credential into the persistent configuration directory
restored device discovery twice without changing device filters.

Container recreation exposed a second failure: a successful SDK login rotated
the passToken in `.mi.token`, but did not update `auth.json`. On restart,
`set_token` discarded that newer SDK identity and seeded login with the older QR
token. A backed-up SDK token could both list the speaker and authenticate afresh,
while the older QR token returned `70016`.

The loader now retains a newer same-account SDK identity, while allowing a newer
QR scan to replace it. Successful logins and SDK request-driven renewals
atomically synchronize the rotated identity into `auth.json`, preserving the
Mijia-specific fields. QR status validates the speaker session first, avoiding
unnecessary Mijia token refreshes when speaker authentication already works.

QR clients now resolve `<current conf_path>/auth.json` for each request rather
than retaining an import-time directory choice. An empty configured path uses
`conf/auth.json`, never the container user's home directory. The completed QR
poll refreshes the speaker AuthManager from that same persisted file.

The API reports `already_logged_in` only after speaker authentication and an
actual device-list request. If Mijia login succeeds while speaker login fails,
the API obtains a fresh QR without deleting the existing credential. The forced
request omits account cookies for that request only.

Regression coverage: `test/test_qrcode_auth.py` exercises the route, credential
path selection, speaker verification and poll-completion boundary. No account,
token value or device identifier belongs in test fixtures or diagnostic output.
`test/test_auth_token_sync.py` covers cached-token precedence, account isolation,
fresh QR replacement and persistence of a rotated SDK identity.

Startup must validate and reuse an existing `micoapi` service session before
attempting passToken/password login. An accepted service token can outlive the
passToken used to obtain it. Unconditionally logging in again discarded valid
speaker access and deleted `.mi.token` when that older passToken was rejected.
The cache validation disables automatic SDK re-login; only a rejected service
session proceeds to the fresh-login path. Tests cover reuse and expiry fallback.

Request failures must also distinguish device/transport errors from authentication
errors. A `/remote/ubus` device timeout (`101`, device code `3012`) must propagate
without clearing cookies or re-running account login. Regression coverage checks
that the cached service and cookie jar remain intact after this failure.

Historical recovery artifacts are private files under `conf/auth-backups/` on
the NAS. They must not be committed or included in public issue attachments.

## Production acceptance, 2026-10-20

After a fresh user scan, two consecutive API checks returned one LX06 and
verified speaker login. A forced container recreation produced a new container
ID; the device list and verified QR-login status still returned one speaker
without another scan. The persistent QR identity and SDK identity matched, and
no home-directory authentication file existed. Both credential files were
restricted to mode 0600 after verification.

All 19 regression tests passed. The recreated deployment also revalidated all
1,387 catalog URLs under the read-only music root, byte-range reads for MP3,
FLAC and OGG, and rejection of external/proxy/traversal playback paths. The web
player displayed the speaker and the 1,387-song catalog. No speaker playback
command was sent as part of this acceptance check.

## Persistent authentication diagnostics

The protected NAS journal is
`/vol1/1000/DockerData/xiaomusic/conf/diagnostics/auth-events.jsonl`.
It appends across container recreation; each record has UTC time, schema version,
process run ID and (within a login/request operation) a shared chain ID.
Each file rotates at 2 MiB with four backups, at most approximately 10 MiB total.
The dedicated directory is mode 0700; current and rotated files are mode 0600.
A filesystem logging failure must not stop authentication or playback.

Records cover the first HTTP error, login phase result codes, CAPTCHA/security
notification presence, login source selection, before/after credential-presence
flags and file modification times, identity/service changes, SDK cache deletion,
QR issuance/completion and polling pause/resume/reinitialization. Login response
bodies, passwords/hashes, cookies, tokens, account/device identifiers, URL query
strings, QR/login URLs and signatures are never copied into this journal.
Only known service endpoints are recorded; other paths become `other`.
Raw SDK authentication payload/traceback logging is replaced with a generic
failure message, with diagnostic codes retained in the protected journal.

For the next failure, preserve `auth-events.jsonl` and its numbered backups,
locate the earliest `http_result` with an error status, then follow its `chain_id`
through `login_started`, `service_login_result`, `login_finished`, and
`service_request_failed`. Compare `before`/`after` flags and
`cache_file_removed` to distinguish a rejected remote session from an SDK
clearing credentials. An API code and security flags are evidence of what the
server returned, not proof of its internal expiry/risk-control decision.

These diagnostics do not make an invalid Xiaomi credential valid. A rejected
session may still require a new authorized login. At this logging release startup,
the persisted SDK session validated successfully and the device endpoint returned
one speaker; that current success does not explain the earlier rejection.
