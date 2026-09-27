# Linekeep agent instructions

Read [docs/HANDOFF.md](docs/HANDOFF.md) before implementation. Then read only the role brief for the directory you own:

- `android/**`: [handoffs/ANDROID_AGENT.md](handoffs/ANDROID_AGENT.md)
- `server/**`: [handoffs/SERVER_AGENT.md](handoffs/SERVER_AGENT.md)

For backend work, claim exactly one eligible task in [tasks.json](tasks.json) before editing. Respect its dependencies and `ownedPaths`; the task manifest is the coordination source of truth.

[docs/API_CONTRACT.md](docs/API_CONTRACT.md) is the integration source of truth. Treat it as frozen during parallel implementation. If a change is necessary, document the proposed change in your role handoff instead of silently changing the contract.

Build Linekeep as a clean implementation using maintained platform libraries. CallSync is a rejected historical project, not a code or architecture source.

Preserve employee visibility: the launcher icon may disappear after onboarding, but Linekeep remains named in Android Settings and exposes an ongoing status notification and Quick Settings entry. Never add covert activation, misleading identity, hidden notification, or permission-evasion behavior.
