# Bot account license implementation plan

Goal: A signed license issued in Telegram must appear on the matching verified
Google account, without extending its duration when replayed.

Constraints: preserve legacy key delivery, never persist raw keys, never modify
existing paid periods. Unverified or different emails cannot claim the grant.

- [x] Reproduce missing bridge: bot only signs a key, never contacts account API.
- [x] Test real Ed25519 signature validation, expiry, duplicate import and account-key rejection.
- [x] Add IssuedLicense table keyed by signed payload identity, email lookup index.
- [x] Merge valid issuer grants into account subscription view without modifying paid periods.
- [x] Test verified recipient, wrong email, trial, expired and perpetual grants.
- [x] Register bot-issued keys with account API before confirming delivery.
- [x] Test bot HTTP boundary using a real local HTTP server.
- [x] Deploy additive database migration and account/bot code with rollback backup.
- [x] Reconcile only the user's most recent audited issuance preserving original expiry.
- [ ] Verify the installed Alpha account shows active Max after refresh.

Server verification: verified Google account returns PRO/ACTIVE until
2026-09-20T05:13:55Z and a valid managed account license. Refresh was requested
through Alpha's existing payment-success deep link (only reloads server state).
Native screenshot capture returned unrelated background content, so visual
verification is not claimed. No recording or active app session was stopped.
Backup: /opt/skillcue/backups/bot-account-20260913 (database + previous code).
