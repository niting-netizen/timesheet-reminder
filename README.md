# Timesheet Reminder

Automated weekly timesheet compliance checks and reminder emails across Jira, Redmine and Pulse.

| Path | What it is |
|------|-----------|
| [plan.md](plan.md) | Specification and delivery plan (v2) |
| [prototype/](prototype/index.html) | Clickable prototype with sample data: https://claude.ai/artifact/YZ7MANcrCB55aSXkxxyGZH |
| [server/](server) | API: Node.js + TypeScript, Fastify, SQLite (built into Node) |
| [web/](web) | Admin dashboard: React + TypeScript (Vite) |
| [shared/](shared) | Settings schema, hour calculations and template filling used by both |

## Status

| Phase | State |
|-------|-------|
| 2. Foundation (project, config, database, encrypted secrets, admin sign-in) | Done |
| 3. Settings UI and real Test Connection (Jira, Redmine, Pulse API, Gmail, Microsoft Graph, SMTP, Groq) | Done |
| Employee master (add, edit, CSV import, source account mapping) | Done |
| 4. Worklog fetching: Jira Cloud/Data Center and Redmine APIs; Pulse/Texpert by file import | Done |
| 5. Weekly check: per-employee logged, required and pending hours; approved leave and holidays; dashboard | Done |
| Pulse API fetching | Waiting for Cloudflare access and confirmed endpoints |
| 6–8. Email sending, scheduler, email history, Excel export | Next |

### How a check works

1. **Run timesheet check** on the Dashboard (any week via "Week of").
2. Each enabled source is fetched for that week: Jira by worklog author (JQL `worklogDate`, then each issue's worklogs), Redmine time entries, and Pulse/Texpert from the latest imported file covering the week.
3. Worklogs are matched to employees through the account IDs on the Employees page. Unknown accounts are listed so you can map them.
4. Each active employee gets a target (weekly hours minus approved leave and holidays) and a status: Complete, Pending, Source data missing (a source they use failed, so no verdict), or No source account.

## Running it

Requires Node.js 22.13 or later (built-in SQLite).

```bash
npm install
cp .env.example .env        # then fill it in:
npm run keygen              #   paste the output into TSR_MASTER_KEY
                            #   set TSR_ADMIN_PASSWORD (12+ characters)
npm run build               # build the dashboard
npm start                   # http://127.0.0.1:8787
```

During development, `npm run dev` runs the API (port 8787) and the dashboard with hot reload (http://localhost:5173).

Other commands: `npm test` (41 tests), `npm run typecheck`.

## Security notes

- API keys, client secrets and passwords are encrypted with AES-256-GCM using a key derived from `TSR_MASTER_KEY`. The API never returns them; the dashboard only shows whether one is saved.
- **Back up `TSR_MASTER_KEY`.** If it is lost, every stored secret has to be entered again.
- Source base URLs must use `https://` unless `TSR_ALLOW_INSECURE_SOURCES=true`.
- Sign-in is a single admin password for now (sessions last 8 hours, failed attempts are throttled). Company SSO with admin, manager and viewer roles is planned before production.
- Connection tests are read-only. The email test checks credentials but sends no mail.
- Groq receives template text only, and a suggestion that changes any placeholder is discarded.
- `.env` and `data/` are git-ignored. Never commit them.
