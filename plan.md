# Timesheet Reminder: Project Plan (v2)

**Multi-Source Timesheet Compliance & Reminder Automation · Jira · Redmine · Pulse**
Prepared for: Iksula Services Pvt Ltd · Owner: Nitin Gomle, Senior Quality Analyst · Revised: 13 Nov 2026

> This revision builds on the 12 Nov 2026 specification. The main change is that **every setting is managed from the web UI**: source credentials, email provider, sender, recipients, week definition, hour targets, templates and AI assist. Each setting can be saved and tested from the screen, so nobody has to edit config files.

---

## 1. What changed from the original spec

| # | Change | Where in the UI |
|---|--------|-----------------|
| 1 | Admins enter the **Jira, Redmine and Pulse API keys** (and Texpert later). Each source has a **Test Connection** button that shows success or failure. | Settings → Sources |
| 2 | **Email templates** can be edited separately for Reminder 1 (Thu 11:00), Reminder 2 (Fri 11:00), Reminder 3 (Fri 13:00, first pending report) and the **Repeat** pending report sent every 2 hours. Each has a live preview. | Settings → Templates |
| 3 | The **From** address, display name and reply-to can be changed. | Settings → Email Provider |
| 4 | **To** is a dropdown with three modes: **Broadcast** (one email listing everyone who is still pending), **Individual** (one email per pending person, showing only their own data) and **Custom** (a selected list of addresses receives the report). The mode can be set per reminder event. | Settings → Recipients, and per event under Schedule |
| 5 | The **week start and end days** (default Monday–Friday) can be changed. | Settings → Schedule & Week |
| 6 | The **weekly hours target** (default 40) can be changed. The daily target is derived from it (40 ÷ 5 = 8) and can be overridden. | Settings → Schedule & Week |
| 7 | The **email provider** is selected in the UI: Gmail API (Google Workspace, the default), Microsoft Graph or SMTP. Each has its own credentials and a Test button. | Settings → Email Provider |
| 8 | Every settings screen has **Save** and **Test**. Test results (time, status, message) are stored and shown. | All settings screens |
| 9 | **AI assist (Groq)**, optional, only in the template editor. See §9. | Settings → AI |

Unchanged: the reminder schedule, business rules, calculation formulas, "data not received" handling, idempotency, dry-run mode, dashboard and Excel export.

---

## 2. Confirmed assumptions and defaults

| Topic | Default / assumption | Status |
|-------|---------------------|--------|
| Jira | Jira Cloud, email + API token, read-only service account | Assumed, to confirm |
| Redmine | REST API with API key (`X-Redmine-API-Key`) | Version to confirm |
| Pulse | Internal app. An API appears to exist (timesheet/worklog read operations were seen through an internal connector), but the endpoints are **not** documented here. Fallbacks are a DB view or a CSV import. | **To confirm** |
| Texpert | Added later as a connector or CSV import | Later |
| Email provider | **Gmail API via Google Workspace** (the company uses Google accounts). SMTP and Microsoft Graph remain selectable. | Default |
| Timezone | Asia/Kolkata | To confirm |
| Week | Monday → Friday, 40 h, 8 h/day | Configurable |
| Group-report recipients | Managers / leads distribution list | List to confirm |
| AI | Groq, optional, template text only | Recommended |
| Build tool | Claude Code (development assistant only, not used at runtime) | Agreed |

---

## 3. Settings model

All settings live in one versioned `settings` document, stored as JSON in the DB. Secrets are stored separately and encrypted (see §4).

```ts
interface Settings {
  version: number;                       // optimistic locking
  sources: SourceConfig[];
  emailProvider: EmailProviderConfig;
  recipients: RecipientConfig;
  week: WeekConfig;
  schedule: ScheduleConfig;
  templates: Record<TemplateId, EmailTemplate>;
  ai: AiConfig;
  ticketMappings: TicketMapping[];
  dryRun: boolean;
}

type SourceType = 'jira' | 'redmine' | 'pulse' | 'texpert';
interface SourceConfig {
  type: SourceType;
  enabled: boolean;
  baseUrl: string;
  authType: 'api_token' | 'api_key' | 'basic' | 'csv_import' | 'db_view';
  username?: string;                     // Jira: account email
  secretRef: string;                     // pointer into secrets table, never the key itself
  lastTest?: { ok: boolean; message: string; latencyMs: number; at: string };
}

interface EmailProviderConfig {
  type: 'gmail' | 'graph' | 'smtp';
  from: string;                          // e.g. timesheet@iksula.com
  fromName: string;
  replyTo?: string;
  gmail?: { clientId: string; secretRef: string; refreshTokenRef: string };
  graph?: { tenantId: string; clientId: string; secretRef: string };
  smtp?:  { host: string; port: number; tls: boolean; user: string; secretRef: string };
  lastTest?: TestResult;
}

type RecipientMode = 'broadcast' | 'individual' | 'custom';
interface RecipientConfig {
  defaultMode: RecipientMode;
  broadcastList: string[];               // who gets the broadcast table
  customList: string[];                  // only these addresses in custom mode
  cc: string[];
}

interface WeekConfig {
  startDay: Weekday;                     // default 'MON'
  endDay: Weekday;                       // default 'FRI'
  weeklyHours: number;                   // default 40
  dailyHoursOverride?: number;           // default = weeklyHours / workingDays
  timezone: string;                      // default 'Asia/Kolkata'
}

type TemplateId = 'R1' | 'R2' | 'R3' | 'REPEAT' | 'INDIVIDUAL';
interface ScheduleEvent {
  id: TemplateId;                        // R1 Thu 11:00, R2 Fri 11:00, R3 Fri 13:00, REPEAT
  enabled: boolean;
  day: Weekday;
  time: string;                          // 'HH:mm' in week.timezone
  intervalHours?: number;                // REPEAT only, default 2
  recipientMode: RecipientMode;          // R1/R2 default broadcast; R3/REPEAT default broadcast
  includePendingTable: boolean;          // false for R1/R2, true for R3/REPEAT
}
interface ScheduleConfig {
  events: ScheduleEvent[];
  cutoffTime: string;                    // e.g. '19:00' Friday
  allowedWindow: { from: string; to: string };
  maxRemindersPerWeek: number;
  paused: boolean;
}

interface EmailTemplate { subject: string; bodyHtml: string; updatedAt: string; updatedBy: string }
interface AiConfig { enabled: boolean; provider: 'groq'; model: string; secretRef: string; lastTest?: TestResult }
```

**Validation** (server-side, using zod):
- `startDay` must come before or equal `endDay`.
- `weeklyHours` must be between 1 and 80.
- Email addresses must be valid.
- `customList` cannot be empty when any event uses custom mode.
- A template must contain only known placeholders.

---

## 4. Secrets handling

- API keys and passwords are typed into password fields and sent to the backend over HTTPS.
- They are stored in a `secrets` table, **encrypted with AES-256-GCM**. The master key comes from the `TSR_MASTER_KEY` environment variable or a secrets manager. It is never kept in the DB, the repo or the frontend.
- The API **never returns a secret**. The UI shows only `•••• set (updated 12 Nov, tested OK)`. The admin can replace or clear a secret but cannot read it back.
- Only the **admin** role can view or edit settings. Manager and viewer roles see the dashboard only.
- Every settings change writes an `audit_log` row (who, what section, when). Secret values are never logged.
- `.env` and `*.sqlite` are listed in `.gitignore`.

---

## 5. Test Connection

Each test runs one minimal **read-only** call, times out after 10 s, and stores the result in `connection_tests`. Tests use the values currently entered in the form, even before they are saved, so an admin can test first and save afterwards.

| Target | Endpoint | Test call | Success means |
|--------|----------|-----------|---------------|
| Jira Cloud | `POST /api/settings/sources/jira/test` | `GET {baseUrl}/rest/api/3/myself` | 200, and returns the account name |
| Redmine | `POST /api/settings/sources/redmine/test` | `GET {baseUrl}/users/current.json` | 200, and returns the login |
| Pulse | `POST /api/settings/sources/pulse/test` | **Endpoint to be confirmed with the Pulse owner** | Defined after discovery |
| Texpert / CSV | `POST /api/settings/sources/texpert/test` | Parse the uploaded sample file | Columns map correctly |
| Gmail API | `POST /api/settings/email/test` | OAuth token refresh, then optionally send to the admin's own address | Token OK, message sent |
| Microsoft Graph | same | Client-credentials token, then `sendMail` to the admin | Token OK, message sent |
| SMTP | same | `transporter.verify()`, then optionally send to the admin | Handshake OK |
| Groq | `POST /api/settings/ai/test` | `GET https://api.groq.com/openai/v1/models` | 200 |

Each test returns `{ ok, latencyMs, message, details? }`. The UI shows a green ✓ or red ✗ with the message, for example "401 Unauthorized: check the API token" or "DNS lookup failed: check the base URL".

---

## 6. Recipient modes (the To dropdown)

| Mode | Who receives | Content | Count per cycle |
|------|--------------|---------|-----------------|
| **Broadcast** | The `broadcastList` (e.g. all-staff or managers/leads DL) | A table of **all** pending employees (EMP ID, Name, Filled, Required, Pending in red) | 1 email |
| **Individual** | Each pending employee's own email (from the employee master) | **Only that employee's** required, logged and pending hours | 1 email per pending employee |
| **Custom** | Only the addresses in `customList`, picked from the employee dropdown or typed in | The same table as Broadcast | 1 email (to the selected addresses) |

Rules:
- R1 and R2 (general reminders) carry no pending table, whatever the mode. In Individual mode they go only to employees who are still pending.
- **Privacy:** Individual mode never includes anyone else's data. This is enforced in the renderer, which receives a single employee row, and is not left to the template.
- **Custom** never emails anyone outside `customList`. This is covered by a unit test.
- **Duplicate protection:** a unique key `(week_start, event_id, cycle_no, recipient)` in `reminder_history`. After a restart, a send is skipped if a row already exists.
- The UI shows a live **"Who will receive this?"** preview of the recipient list and count before saving or running.

---

## 7. Week and target calculation (updated)

```
workingDays     = days from week.startDay to week.endDay (inclusive), e.g. Mon–Fri = 5
dailyHours      = week.dailyHoursOverride ?? week.weeklyHours / workingDays
baseTarget      = week.weeklyHours
adjustedTarget  = baseTarget − (approvedLeaveDays + publicHolidayDays) × dailyHours − otherApprovedAdjustments
pendingHours    = max(0, adjustedTarget − loggedHours)
completion %    = min(100, loggedHours / adjustedTarget × 100)
```

- Week boundaries are computed in `week.timezone`. Friday worklogs count until 23:59 on the end day. The cutoff for "final" status is configurable.
- Changing `weeklyHours` or the days takes effect on the **next check**. Previously sent reports are not rewritten.
- Leave and holiday adjustments apply **only when approved and recorded**. Leave is never inferred from free text.

---

## 8. Reminder schedule (defaults, all editable)

| Event | When | Template | Pending table | Default To mode |
|-------|------|----------|---------------|-----------------|
| R1 | Thursday 11:00 | General reminder | No | Broadcast |
| R2 | Friday 11:00 | General reminder | No | Broadcast |
| R3 | Friday 13:00 | Pending report #1 | Yes | Broadcast |
| REPEAT | Every 2 h after R3 (15:00, 17:00, …) | Pending report #n | Yes | Broadcast |

Stop conditions: nobody is pending, the cutoff time is reached, `maxRemindersPerWeek` is reached, or the schedule is paused. No email is ever sent outside the allowed window or on non-working days. A final compliance check after working hours on Friday produces the final report for managers.

---

## 9. AI assist with Groq (recommended scope)

**Recommendation:** use Groq only to help the admin **write and polish email templates**. Don't use it for hours, statuses or recipients. This keeps compliance decisions deterministic and auditable, as the original spec requires (§7, §20).

| Feature | What it does | Data sent to Groq |
|---------|--------------|-------------------|
| Polish | Fixes grammar and clarity in a template | Template text with placeholders only |
| Change tone | Friendly / firm / formal | Template text only |
| Shorten | Produces a concise version for mobile readers | Template text only |
| Draft | Writes a new template from a one-line brief | The brief only |

- **No employee names, emails or hours** are ever sent to Groq. Placeholders such as `{employee_name}` are sent as literal text.
- The AI output is shown as a **suggestion** with a diff. The admin must click *Apply* and *Save*, so nothing changes automatically.
- AI assist is disabled by default. The admin enables it in Settings → AI, enters the Groq key and model (e.g. `llama-3.3-70b-versatile`), and clicks Test.
- If Groq is down, the template editor keeps working without it.
- Claude (basic access) is used by the team to **build** the app in Claude Code. It is not called at runtime.

---

## 10. Email templates

Placeholders: `{week_start} {week_end} {week_number} {daily_hours} {weekly_hours} {applications} {leave_ticket} {public_holiday_ticket} {bench_ticket} {sender_name} {sender_title} {office_addresses} {report_number} {pending_count} {next_run_time} {source_notes} {pending_table} {employee_name} {required} {logged} {pending}`

| Template | Default subject | Notes |
|----------|-----------------|-------|
| R1: Thursday general | `Timesheet Reminder: {week_start} to {week_end}` | Iksula general reminder text from the original spec |
| R2: Friday general | `Timesheet Reminder (Final Day): {week_start} to {week_end}` | Same body with a "today is the last day" line |
| R3: First pending report | `Timesheet Pending List #1: {pending_count} employees pending` | Includes `{pending_table}` |
| REPEAT: Every 2 hours | `Timesheet Pending List #{report_number}: {pending_count} employees pending` | Includes `{pending_table}` and `{next_run_time}` |
| INDIVIDUAL | `Action needed: complete your timesheet for {week_start} to {week_end}` | Used for any event sent in Individual mode |

The editor provides subject and body fields, placeholder chips to insert, a live preview with sample data in the selected To mode, **Send test to me**, **Reset to default** and version history.

---

## 11. Architecture

```
React + TS dashboard ──HTTPS──> Node.js + TS API (Fastify)
                                  ├─ settings service  (zod validation, versioning, audit)
                                  ├─ secrets service   (AES-256-GCM)
                                  ├─ connection tester (per source / provider / AI)
                                  ├─ connectors/       jira · redmine · pulse · csv  (TimesheetConnector)
                                  ├─ normalizer        → common worklog record
                                  ├─ calculator        (pure, unit-tested)
                                  ├─ policy/calendar   (week config, leave, holidays, windows)
                                  ├─ reminder service  (modes, dedupe, limits)
                                  ├─ email/            gmail · graph · smtp  (EmailProvider)
                                  ├─ ai/               groq (template assist only)
                                  ├─ scheduler         (node-cron; rebuilt when schedule settings change)
                                  └─ SQLite (prototype) → PostgreSQL (production)
```

Interfaces:

```ts
interface TimesheetConnector {
  type: SourceType;
  testConnection(cfg: SourceConfig, secret: string): Promise<TestResult>;
  fetchWorklogs(range: { from: Date; to: Date }, cfg: SourceConfig, secret: string): Promise<RawWorklog[]>;
}
interface EmailProvider {
  testConnection(cfg: EmailProviderConfig, secrets: Secrets): Promise<TestResult>;
  send(msg: { from: string; to: string[]; cc?: string[]; subject: string; html: string }): Promise<{ id: string }>;
}
```

When schedule settings are saved, the scheduler **reloads its cron jobs immediately**, so no restart is needed.

---

## 12. Database tables

The tables from the original spec are kept: `employees`, `source_accounts`, `sources`, `ticket_mappings`, `worklogs`, `weekly_timesheets`, `work_schedule`, `calendar_adjustments`, `schedule_config`, `reminder_history`, `check_runs`.

New tables:

| Table | Key fields | Purpose |
|-------|-----------|---------|
| `settings` | id, version, json, updated_at, updated_by | The current configuration from §3 |
| `secrets` | ref, ciphertext, iv, tag, updated_at, updated_by | Encrypted API keys and passwords |
| `connection_tests` | id, target, ok, latency_ms, message, tested_at, tested_by | Test Connection history |
| `email_templates` | id, template_id, subject, body_html, version, updated_at, updated_by | Template versions for history and rollback |
| `audit_log` | id, actor, action, section, at | Settings changes (secret values are never logged) |

`reminder_history` gains `event_id`, `cycle_no` and `recipient_mode`, with a unique index on `(week_start, event_id, cycle_no, recipient)`.

---

## 13. Dashboard and screens

- **Dashboard**: summary cards (total, completed, pending, adjusted-target employees, last run). The employee table shows logged, required and pending hours, completion %, last reminder, reminder count and status. Filters cover week, team, project and source. Buttons: Run Check, Send Test Email, Export Excel, Pause/Resume.
- **Settings → Sources**: one card per source with enable, base URL, user/email, API key (masked), **Test Connection** and the last test result.
- **Settings → Email Provider**: provider dropdown, provider-specific fields, From, From name, Reply-to, **Test**.
- **Settings → Recipients**: default To mode, broadcast list, custom list (multi-select from the employee master plus free entry), CC, and the live "who will receive" preview.
- **Settings → Schedule & Week**: start and end day, weekly hours (with daily hours derived), timezone, events R1/R2/R3/REPEAT (day, time, interval, To mode, enabled), cutoff, allowed window, max reminders.
- **Settings → Templates**: tabs for R1, R2, R3, REPEAT and INDIVIDUAL, an editor with preview, and AI assist.
- **Settings → AI**: enable, Groq key, model, **Test**.
- **Settings → Employees, Ticket mappings, Dry-run**: as in the original spec.
- **Email History**: every send with mode, recipients, status and provider message ID.

---

## 14. Testing scenarios (original 1–18 kept, plus these)

19. Test Connection with a wrong Jira token shows ✗ "401 Unauthorized" and saves nothing.
20. Test Connection with correct values shows ✓, and the result is stored and displayed.
21. The API never returns a secret value, checked by an API test over every settings endpoint.
22. Changing From to `timesheet@iksula.com` means the next send uses that sender.
23. Broadcast mode sends one email to the broadcast list, containing every pending employee.
24. Individual mode sends N emails for N pending employees, each containing exactly one employee's data.
25. Custom mode with 2 selected addresses sends to exactly those 2 and nobody else.
26. Changing the week to Mon–Sat with 48 h gives a daily target of 8 and 6 working days, and targets recalculate on the next check.
27. Changing weekly hours to 45 gives Complete/Pending statuses based on 45.
28. Editing the REPEAT template changes only the 2-hourly emails. R3 is unchanged.
29. Changing the schedule time reloads cron jobs without a restart.
30. Groq is down: the template editor still works, and AI assist shows "unavailable".
31. A non-admin user cannot open or change settings (403).

---

## 15. Delivery phases

| Phase | Work | Exit criteria |
|-------|------|---------------|
| 0. Prototype (**this deliverable**) | Clickable HTML prototype of every screen, with mock data and simulated tests | Stakeholders review the shared link |
| 1. Discovery | Confirm the open decisions in §16 | Approved access plan |
| 2. Foundation | TS monorepo (api + web), SQLite, settings and secrets services, auth/roles | App starts, settings save and load |
| 3. Settings UI + Test Connection | All settings screens wired to the API. Jira, Redmine, SMTP/Gmail and Groq tests work. | Real tests pass against test accounts |
| 4. Connectors | Jira and Redmine fetch, Pulse (method confirmed), CSV import | Totals match the manual extract |
| 5. Calculator | Week config, targets, adjustments, unit tests | Example cases pass |
| 6. Email + recipient modes | Templates, the three To modes, dry-run, history | Dry-run renders correctly for each mode |
| 7. Scheduler | Events, repeat, cutoff, dedupe, hot reload | Scheduled dry runs behave predictably |
| 8. Dashboard + export | Cards, table, filters, Excel | Managers can review and export |
| 9. UAT + production | Security review, sign-off | Business owner approves live sending |

---

## 16. Decisions still needed

1. **Pulse:** API endpoint and auth, a DB view, or a CSV export?
2. **Jira:** Cloud or Data Center? A read-only service account?
3. **Redmine:** version and base URL, and whether an API key is available for a service user.
4. **Google Workspace:** permission to create an OAuth client (Gmail API) or an app password for SMTP relay, and the sender mailbox (e.g. `timesheet@iksula.com`).
5. **Broadcast list:** the exact distribution list(s).
6. **Timezone and Friday cutoff** time.
7. **Leave, holiday and bench ticket** names per source, and the source of approved leave.
8. **Office addresses** for the signature.
9. **Groq:** confirm that sending template text (no employee data) to Groq is acceptable under company policy.
