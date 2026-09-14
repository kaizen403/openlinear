# Alerts (Phase 1.6 / C5 §7.3)

These are the signals to page on. Wiring Azure Monitor / Grafana is staging work
and is **not** done from this repo until Redis + a second replica exist.

| Alert | When | First response |
|---|---|---|
| Auth failure spike | 5xx or 401 rate > 20× baseline for 5 min | Check JWT_SECRET / PAT revoke / IdP |
| Outbox lag | `domain_events.published_at` null older than 30s | Restart `openlinear-worker`; check Redis |
| Replica count > expected | Container App replicas > 1 without Redis | Scale back to 1 |
| Neon connection saturation | `remaining` < 10% | Kill idle workers; do not add replicas |
| Sandbox violation rate | sidecar denials climbing | Freeze execution; read sidecar logs |

Do **not** raise `--max-replicas` until Redis, the outbox relay, and Blob
attachments are live in that environment.
