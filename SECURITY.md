# Security

Linekeep handles call metadata, device credentials, and private audio. Please report suspected vulnerabilities privately rather than opening a public issue or pull request with exploit details.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/shubhsherl/linekeep/security/advisories/new) for this repository. You will need to sign in to GitHub.

Include:

- The affected version or commit and component: Android, Worker, administrator UI, or deployment configuration.
- The security boundary involved and the access an attacker would need.
- Reproduction steps using synthetic identities and generated, non-personal data.
- Expected and observed behavior, impact, and any suggested mitigation.

Do not send real recordings, employee or caller information, tokens, invitation/recovery codes, signing keys, private configuration, or database exports. Use placeholders and explain how to reproduce with disposable local credentials. If the private reporting form is unavailable, do not publish the vulnerability in an ordinary issue; a public issue may request that private reporting be enabled without disclosing security details.

## Deployment responsibilities

- Protect `/admin`, `/v1/admin`, and their descendants with Cloudflare Access and a narrow allow policy. Device routes use separate device authentication.
- Keep R2 private and keep secrets and deployment-specific configuration out of Git.
- Do not deploy the local administrator bypass secret. It is for loopback development only.
- Revoke a compromised device credential through the administrator controls. Treat exposed enrollment and recovery codes as credentials.
- Keep the hashing secret stable during routine upgrades. If it is compromised, plan credential recovery before changing it.
- Define and operate retention, consent, access-review, backup, and erasure procedures. Deletion retains internal tombstones and does not remove phone originals or downloaded copies.

See the [backend guide](server/README.md) for deployment details and the [README](README.md#retention-and-deletion) for deletion limits.
