# Personal Workflow System — Design

A private, deterministic pipeline that watches my sources, proposes Jira tickets in a
private project for me to confirm, and gives me a Slack-based agent for querying and
bulk-editing those tickets.

Unrelated to `gx.sh` at the repo root.

---

## 1. Guiding principle: determinism where it counts

The hard requirement is "deterministic scripts, not agents that hallucinate." The way to
honour that without giving up on useful summarisation is to split the pipeline into two
layers with a bright line between them:

| Layer | What it decides | How | Can it be wrong? |
|---|---|---|---|
| **Selection** | *Whether* something becomes a ticket | Pure, tested rules over explicit triggers | No — it's an `if` statement |
| **Drafting** | *What the ticket says* | LLM, schema-validated, with deterministic fallback | Yes, but it lands in `Staged` for me to confirm |

**Selection never involves an LLM.** Every source has an *explicit, user-driven trigger* —
a reaction emoji, a Gmail label, a specific Drive folder. Nothing gets swept up because a
model "thought it sounded like a task." That single decision eliminates the entire class
of failure I'm worried about.

**Priority and due date are also rules, not LLM output** (see §5). The model may *suggest*
an override with a stated reason, but the default that gets written is computed by tested
code.

---

## 2. Architecture

```
                     ┌──────────────── GitHub Actions (cron */5) ────────────────┐
                     │                                                            │
  Slack ──┐          │   collect()  →  dedupe()  →  triage()  →  draft()  →  create()
  Granola ─┤         │      │            │            │            │           │
  Gmail ×N ┼─ APIs ──┼──────┘            │            │            │           │
  Drive ──┤          │              (JQL by hashed    (pure       (Claude,     │
  Calendar┤          │               source-key       rules)      validated)   │
  Jira ───┘          │               label)                                     │
                     └────────────────────────────────┬───────────────────────────┘
                                                      ▼
                                    ┌─────────────────────────────────┐
                                    │  Jira: private project (RUPA)  │
                                    │  status = Staged          │
                                    └─────────────────────────────────┘
                                                      ▲
                     ┌──── Fly.io machine (Phase 3) ───┴──┐
                     │  Slack Socket Mode agent           │
                     │  NL → typed op → dry-run → confirm │
                     └────────────────────────────────────┘
```

### Where things run

**Ingest → GitHub Actions cron, every 5 minutes.** Free, versioned alongside the code, gives
a per-run audit log, and — critically — being ephemeral *forces* the stateless, idempotent
design in §4, which is exactly what makes the whole thing unit-testable.

**One cliff to defuse first.** GitHub disables a scheduled workflow after **60 days with no
commit activity** in the repo. Only pushes reset the timer — issues, PRs and releases do not.
GitHub's docs frame this as a public-repo policy, but it is widely reported against private
repos too, so I assume it applies. Unmitigated it silently kills the whole system two months
after my last commit. Mitigation is a keepalive workflow pushing a timestamp commit monthly;
once the Phase 4 routines exist and open PRs, they generate qualifying activity themselves.

Note how the two clocks interact: if cron stops, the Graph refresh token then sits unused. On a
public-client registration that kills it within 24 hours — the second reason §3.1 insists on a
confidential client, where there is a 90-day cushion instead.

**Slack agent → one small always-on process (Fly.io machine).** Slack's Events API requires
answering an HTTP request within 3 seconds, which cron cannot do. **Socket Mode** avoids that
entirely: the app opens an outbound WebSocket, so there's no public URL, no TLS cert, and no
request-signature verification to get wrong.

Deliberately, **this machine does not exist until Phase 3.** No server to pay for or patch
until conversational access is actually being built. A Cloudflare Worker on the Events API is
the serverless alternative if a persistent process is unwanted; it trades the machine for
signature verification and a 3-second ack budget.

---

## 3. Sources

Every source is an adapter behind one interface, so adding a source is a new file plus
fixtures — never a change to the pipeline.

```ts
interface SourceItem {
  sourceKey: string;      // stable, globally unique — see §4
  source: SourceName;
  title: string;          // deterministic fallback title
  body: string;           // raw text handed to the drafter
  url: string;            // deep link back to the original
  occurredAt: Date;
  actors: string[];
  hints: TriageHints;     // channel, labels, folder, meeting attendees…
}
```

| Source | Auth | Explicit trigger | Notes |
|---|---|---|---|
| **Slack** | User token (OAuth) | I add a `:ticket:` reaction | User token needed for DMs + private channels. A bot token only sees channels the bot is in. |
| **Granola** | Bearer `grn_` key | Action items assigned to me | Public REST API, read-only. **Requires a Business plan to mint keys.** Structured action items mean minimal drafting needed. |
| **Email — Gmail** | Gmail API, one refresh token per account | Gmail label `→jira` | Refresh tokens are long-lived and do **not** rotate. The simplest adapter of the six. |
| **Email — Microsoft 365 / Outlook** | MS Graph — see §3.1 | Outlook **category** `→jira`, or a dedicated mail folder | Categories are the Gmail-label analogue (`message.categories` on Graph). Whether Superhuman surfaces categories on an Outlook account is **untested** — the folder trigger is the guaranteed fallback. |
| **Google Drive** | Drive API | Comment @-mentioning me, or a file landing in a watch folder | `comments.list` per changed file; `changes.list` with a page token for the folder watch. |
| **Calendar** | Google Calendar API and/or Graph `Calendars.Read` | Event title/description matches a configured pattern | If the M365 account holds the real calendar, it comes free from the same Graph app registration. |
| **Other Jira projects** | Same Jira API token | Issue assigned to me outside `RUPA` | Creates a linked mirror, not a copy. |

**Superhuman has no public API**, and does not need one: it is a client over Gmail and
Outlook, so polling those directly sees everything Superhuman sees.

**Multi-account email is config, not code:** `accounts: [{alias, provider, credentialRef}]`.
Both providers implement the same `EmailAdapter`, so `provider: 'gmail' | 'graph'` is the only
thing that differs between accounts.

### 3.1 Microsoft 365 auth — delegated, committed

No tenant admin, so this is settled: **authorization code flow with `offline_access`.** Access
is inherently scoped to my own mailbox, so no application access policy is needed and no admin
consent is involved.

**Register as a confidential client, not a public one.** This is the load-bearing detail.
Entra treats the two classes differently: a **public client** (the "Mobile and desktop
applications" platform) gets a refresh token that must be *used at least once every 24 hours*
or it goes inactive and dies, even though its ceiling is 90 days. A **confidential client**
(the "Web" platform, with a client secret) gets the plain 90-day sliding window with no daily
liveness requirement. Given that this system will be paused, debugged and left alone over
weekends, the 24-hour cliff is not survivable.

```
Platform:     Web
Redirect URI: http://localhost:7331/callback   (one-time bootstrap only)
Scopes:       Mail.Read  offline_access  Calendars.Read
Secrets:      client id + client secret + tenant id  → GH Actions secrets
              refresh token                          → KV store (§4.1)
```

**Bootstrap is one manual command, run once per account at the laptop:**

```
wf auth graph --alias work
  → opens the consent page in a browser
  → catches the code on the loopback redirect
  → exchanges it, writes the refresh token to the KV store
  → prints the expiry date of the client secret
```

**The client secret expires** — Entra caps them at 24 months, and many tenants clamp that far
shorter by policy. That is a hard outage with a knowable date, so the system files a ticket
against itself: a routine opens an `RUPA` issue 30 days before expiry. Rotating the secret
does not invalidate the refresh token.

### 3.2 Rotation safety — the protocol that prevents lockout

Entra returns a **new** refresh token on every refresh and invalidates the old one. A run that
obtains a token and then fails to persist the replacement locks the source out permanently.
Four rules, all of them testable:

1. **Persist before use.** Write the new refresh token to the store *first*; only then use the
   access token for anything. If the write fails, abort the run and change nothing else.
2. **Keep the previous token.** Store `refresh_token`, `refresh_token_prev` and `rotated_at`.
   The old token is dead on arrival, but having it makes a post-mortem possible instead of
   guesswork.
3. **One writer at a time.** A compare-and-swap lease on the KV key, plus
   `concurrency: { group: ingest, cancel-in-progress: false }` on the workflow, so the Actions
   runner and the Phase 3 machine can never refresh concurrently.
4. **Alarm on staleness.** A routine pages me in Slack if `rotated_at` is older than six hours.
   This matters more than it looks: the failure mode here is *email quietly stops producing
   tickets*, which is worse than a crash because nothing announces it.

Recovery must stay cheap and documented — re-running `wf auth graph --alias work` takes about
thirty seconds. The protocol exists to make lockout rare, not impossible.

---

## 4. Idempotency — the design that makes this testable

There is **no state database.** Each run looks back over a fixed window (default 48 h) and
re-derives candidates from scratch. Duplicate suppression works by asking Jira what already
exists:

```
sourceKey  = "slack:T123/C456/1712345678.123456"     // human-readable, stored in a custom field
dedupeLabel = "srckey-" + sha1(sourceKey).slice(0,16) // exact-matchable in JQL
```

Jira short-text custom fields only support fuzzy `~` in JQL, which is not safe for dedup.
Labels support exact `=` and `in`, so a **hashed label carries the dedup** and the readable
key lives in a custom field for debugging. One batched query per run:

```
project = RUPA AND labels IN (srckey-aaa, srckey-bbb, ...)
```

Consequences worth stating plainly:

- Running ingest twice is a no-op. A failed run self-heals on the next tick.
- Deleting a ticket makes it come back — so **rejection is a status (`Rejected`), not a delete**,
  and rejected keys stay in the dedup set.
- The whole pipeline is a pure function of `(fixtures, clock)`, which is why §8 is easy.

### 4.1 The one piece of state — and what it is *not*

Staging lives in Jira (§6), so the only things that refuse to be stateless are a rotating Graph
refresh token (§3.2) and Drive's `changes.list` page token. That is a **credential and cursor
store** — a single key/value namespace, nothing more:

```
graph:<alias>:refresh_token       rotated on every run — see §3.2
graph:<alias>:refresh_token_prev  previous value, for post-mortems
graph:<alias>:rotated_at          drives the staleness alarm
graph:<alias>:lease               compare-and-swap, one writer at a time
drive:changes_page_token          advanced on every run
gmail:<alias>:refresh_token       stable — Google's do not rotate
```

**It never holds issue state.** Whether a ticket already exists, and whether it is still
awaiting my approval, are both answered by Jira and only by Jira. Losing this store costs one
re-auth and one wider Drive sweep — never a duplicate ticket and never a lost approval.

Implementation: **Cloudflare KV over its REST API** — free, no server, reachable from both the
Actions runner and the Phase 3 machine. Point reads and writes are all this needs.

Either way the ingest workflow takes `concurrency: { group: ingest, cancel-in-progress: false }`
so two runs can never rotate the same token simultaneously. Consolidating onto the Phase 3
machine (§12) retires the problem outright by leaving exactly one writer.

---

## 5. Triage rules — priority and due date

Computed by tested pure functions, from source and hints. Illustrative table, to be tuned:

| Source | Default priority | Default due |
|---|---|---|
| Slack `:ticket:` in an incident channel | High | +1 business day |
| Slack `:ticket:` elsewhere | Medium | +3 business days |
| Granola action item | Medium | +7 days, or the meeting's stated date if present |
| Email labelled `→jira` | Medium | +5 business days |
| Email from a VIP sender list | High | +2 business days |
| Drive comment mention | Low | +7 days |
| Mirrored Jira issue | Inherits upstream | Inherits upstream |

The drafter may return `suggestedPriority` + `reason`. That suggestion is written to a comment
on the issue, **not to the priority field**, so what I confirm is always the rule-derived value
unless I choose otherwise. Keyword escalation (`blocker`, `outage`, `EOD`) is a deterministic
rule, not a model judgement.

---

## 6. Staging — a status, not a second system

Reacting with `:ticket:` puts the item in Jira immediately, in status **`Staged`**, with title,
priority and due date pre-filled. That status *is* the staging area. I clear the backlog in
bulk later by talking to the Slack agent.

```
:ticket: reaction
      ↓  within 5 min
   Staged ──────▶ To Do ──▶ In Progress ──▶ Done
      │
      └─────────▶ Rejected      terminal; keeps the dedup key so it never resurfaces
```

**Why a status rather than a separate staging table.** An external queue would keep Jira
pristine, but it would also introduce a second source of truth for "does this item already
exist" — and that single-source property is exactly what makes §4 idempotent, self-healing and
cheap to test. A status keeps one store, needs no backups, survives losing everything else, and
costs only cosmetics: rejected tickets leave tombstones, and their issue keys are spent.

It also means the Slack agent needs **no new operations**. A staged item is just
`project = RUPA AND status = Staged`, so every bulk op from §7 already works on the queue, and
approving in bulk is an ordinary `bulk_transition`.

**Everything else in the project can ignore it:** boards, filters and reports carry
`status != Staged` and behave as though the queue were external.

### The real risk is rot

A staging queue nobody looks at is worse than creating tickets outright, because the work then
sits invisible in both places. Three defences:

- A daily digest in Slack — *"9 staged, oldest 4 days"* — with an **Approve all** button.
- An escalating nag on anything staged more than 7 days.
- A hard TTL at 21 days: auto-transition to `Rejected` and tell me. The ticket still exists and
  can be reopened, so the queue cannot grow without bound and nothing is truly lost.

**Before the Slack agent exists** (Phases 1–2), review runs locally: `wf stage review` walks the
queue with keyboard shortcuts. The CLI stays afterwards — it is still the fastest way to clear a
large backlog.

### Jira setup (manual, one time)

- The project **already exists**: `RUPA` — "To Do's" on `casedrive.atlassian.net`, a
  **team-managed business (Work Management)** project, currently empty. Team-managed is
  what we want: statuses and fields can be edited without a Jira admin.
- Two consequences of it being a *business* project rather than software: its settings live
  under `/jira/core/projects/RUPA/…` (not `/jira/software/…`, which 404s), and team-managed
  projects attach custom fields **per issue type**, so the three fields go on `Task`.
- **It is currently visible to the whole site** (`isPrivate: false`). Requirement 3 says
  private, so access needs restricting before anything real lands in it.
- `wf setup` prints this checklist with the real URLs; `wf doctor` then verifies every
  item and prints the exact `JIRA_FIELD_*` ids to paste into `.env`.
- Statuses: `Staged → To Do → In Progress → Done`, plus `Rejected` as a terminal state.
- Custom fields: `Source` (select), `Source Key` (short text), `Source URL` (url).
- A remote issue link back to the original, so "view original" is one click.
- Auth by Atlassian account email plus an API token — far simpler than 3LO OAuth for one user.

---

## 7. The Slack agent — querying and bulk operations

Yes, Slack works as the interface. DM the bot, or `/wf <question>` in any channel.

Determinism is preserved by never letting the model touch Jira directly. It fills parameters
on a **fixed, typed set of operations**:

```ts
type Op =
  | { kind: 'search';            jql: string }
  | { kind: 'bulk_set_priority'; jql: string; priority: Priority }
  | { kind: 'bulk_set_due';      jql: string; due: DateExpr }
  | { kind: 'bulk_transition';   jql: string; to: Status }
  | { kind: 'bulk_label';        jql: string; add?: string[]; remove?: string[] }
  | { kind: 'bulk_comment';      jql: string; body: string };
```

Flow: **NL → validated `Op` → run the JQL read-only → post a dry-run plan → I tap Confirm.**

```
You:  bump everything from last week's incident channel to High and due Friday
Bot:  Plan: bulk_set_priority + bulk_set_due
      JQL: project = RUPA AND labels = "src-slack-incidents" AND created >= -7d
      Matches 14 issues:
        RUPA-231  Rotate the staging cert
        RUPA-238  Follow up with vendor on the 4xx spike
        … 12 more
      → Set priority High, due 2026-08-28
      [Confirm]  [Edit JQL]  [Cancel]
```

Nothing writes before Confirm. Every executed op is appended to an audit log channel with the
resulting issue keys, so a bad bulk edit is always reversible by hand.

**Slack app scopes:** `reactions:read`, `channels:history`, `groups:history`, `im:history`,
`chat:write`, `commands`, plus `connections:write` for Socket Mode.

---

## 8. Testing

The requirement is that extending the system can't silently break it. Layers:

- **Rule tests** — `triage()`, `fingerprint()`, date maths, keyword escalation. Pure functions,
  table-driven, fast. This is where most of the value is.
- **Adapter contract tests** — recorded real API payloads as fixtures, replayed with `msw`.
  Catches upstream schema drift without hitting the network.
- **Idempotency test** — run the pipeline twice over the same fixtures; assert exactly one
  `createIssue` call. This is the single most important test in the suite.
- **Drafting tests** — Anthropic client mocked. Assert schema validation rejects malformed
  output and that the deterministic fallback (first line as title, rule-derived priority,
  rule-derived due) engages on failure.
- **Golden/eval run** — a separate, non-blocking `npm run eval` over a small corpus of real
  items, so drafting-quality drift is visible without making CI flaky.

**Gating:** `husky` pre-commit runs `tsc --noEmit` + `vitest related --run` + `gitleaks` on
staged files. CI runs the full suite on PR, with branch protection on `main` requiring it.

---

## 9. Routines

A routine is a checked-in YAML file — so scheduled queries are code-reviewed and versioned,
which satisfies the "in git" requirement for free.

```yaml
# workflow/routines/staging-digest.yaml
name: staging-digest
schedule: "0 9 * * 1-5"
query: project = RUPA AND status = "Staged" ORDER BY created ASC
action: none                 # digest only; Approve all is a button on the message
report_to: "#rupa-workflow"
escalate_after: 7d           # nag
ttl: 21d                     # then auto-transition to Rejected and say so
```

From Slack, *"save that as a routine called staging-digest"* makes the agent **open a PR** adding
the file. Routines with a mutating `action` require the PR to be merged by me — a second
approval gate on anything recurring and destructive.

---

## 10. Privacy

Private repo, private Jira project, secrets in GitHub Actions encrypted secrets (local dev uses
a gitignored `.env`, with `.env.example` committed).

Worth stating explicitly: **the drafting step sends email and Slack content to the Anthropic
API.** That's the one genuine data-egress point in the design. Mitigations available:

- `llm: false` per source in config — that source uses deterministic drafting only.
- A redaction pass stripping known-sensitive patterns before drafting.
- Selection is rules-only, so *nothing is sent to any model unless I explicitly triggered it*
  with a reaction or a label. Nothing is passively scanned.

---

## 11. Code architecture — ports and adapters

Every single thing this system does is talk to somebody else's API, so the shape almost picks
itself: **hexagonal.** The core owns a set of interfaces; vendor SDKs live only in adapters that
implement them. Two rules keep it honest.

**Classes at the seams, functions in the core.** Anything with dependencies, anything that gets
swapped or extended — a source, a store, an operation — is a class behind an interface. Anything
that is a pure transformation — `fingerprint()`, date maths, JQL building, redaction, draft
validation — stays a plain function. Wrapping pure logic in classes buys ceremony and nothing
else.

### 11.1 The ports

```ts
// src/ports — the core depends on these and never on a vendor SDK

export interface Source {
  readonly name: SourceName;
  collect(window: TimeWindow): Promise<SourceItem[]>;
}

export interface TicketStore {
  findExisting(keys: DedupeKey[]): Promise<Set<DedupeKey>>;
  create(draft: TicketDraft): Promise<IssueKey>;
  search(jql: string): Promise<Issue[]>;
  transition(keys: IssueKey[], to: Status): Promise<void>;
  update(keys: IssueKey[], patch: IssuePatch): Promise<void>;
}

export interface CredentialStore {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  swap(k: string, expected: string | null, next: string): Promise<boolean>;  // CAS, §3.2
}

export interface Drafter  { draft(item: SourceItem): Promise<Draft>; }
export interface Notifier { post(channel: string, msg: Message): Promise<void>; }
export interface Clock    { now(): Date; }
```

`Clock` looks like over-engineering until the first due-date test. Every date rule in §5 is
relative, so an injectable clock is what makes them assertable at all.

### 11.2 Two registries — the only places extension happens

Adding a source is a new class and one registry line. The pipeline never imports a concrete
source, so it cannot break when a seventh arrives.

```ts
export class SourceRegistry {
  private readonly sources = new Map<SourceName, Source>();
  register(s: Source): this { this.sources.set(s.name, s); return this; }
  enabled(cfg: Config): Source[] { /* config decides, not code */ }
}
```

### 11.3 Operations as commands — where OO earns its keep

This is the one place the object model buys a guarantee rather than tidiness. Every agent
operation implements:

```ts
export interface Operation {
  readonly kind: OpKind;
  /** Read-only. Returns what WOULD change. Must never mutate. */
  plan(store: TicketStore): Promise<Plan>;
  /** Only callable with a Plan — and a Plan can only come from plan(). */
  execute(plan: Plan, store: TicketStore): Promise<OpResult>;
}
```

Because `execute` demands a `Plan`, and `Plan` is only constructible by `plan()`, **an operation
cannot run without first having produced the dry-run I confirm.** The safety property from §7 is
enforced by the type system rather than by remembering to do it. A future operation that tries
to skip the confirm step will not compile.

### 11.4 Failure isolation

One broken adapter must never stop the other six. Sources are run independently and their
failures are collected, reported and survived:

```ts
export class Pipeline {
  constructor(
    private readonly sources: SourceRegistry,
    private readonly dedupe: Dedupe,
    private readonly triage: TriageRules,
    private readonly drafter: Drafter,
    private readonly tickets: TicketStore,
    private readonly clock: Clock,
  ) {}

  async run(window: TimeWindow): Promise<RunReport> {
    const results = await Promise.allSettled(
      this.sources.enabled(cfg).map(s => s.collect(window)),
    );
    // rejected sources become warnings in the report; the run continues
  }
}
```

### 11.5 Rules as strategies

```ts
export interface TriageRule {
  readonly id: string;
  matches(item: SourceItem): boolean;
  apply(item: SourceItem, clock: Clock): Partial<Triage>;
}
```

A new rule is a new class in `core/rules/`, appended to the set. Existing rules are never
edited, so an added rule cannot regress an existing one — and because `apply` is pure, the whole
set is table-testable.

### 11.6 What this does for the tests

Every port gets an in-memory fake. The core suite uses **fakes, not mocks** — no `vi.mock`, no
brittle call-order assertions. The §8 idempotency test collapses to this:

```ts
const tickets = new InMemoryTicketStore();
const pipeline = new Pipeline(
  new SourceRegistry().register(new StubSource([item])),
  new Dedupe(tickets), new TriageRules(defaultRules),
  new StubDrafter(), tickets, new FakeClock('2026-08-23T09:00:00Z'),
);

await pipeline.run(window);
await pipeline.run(window);
expect(tickets.created).toHaveLength(1);
```

### 11.7 Layout, and the rule that keeps it from rotting

```
workflow/
  src/
    domain/     SourceItem · Triage · TicketDraft · fingerprint · dates    (pure, no I/O)
    ports/      Source · TicketStore · CredentialStore · Drafter · Notifier · Clock
    core/       Pipeline · Dedupe · TriageRules · SourceRegistry · rules/
    adapters/   jira/ slack/ granola/ google/ graph/ anthropic/ cloudflare/
    agent/      ops/ (one class per operation) · Planner · Confirm · SlackApp
    routines/   Runner
    container.ts   composition root — the only file allowed to construct adapters
    cli.ts         wf ingest | wf stage review | wf ask | wf routine run | wf doctor
  test/
    fakes/      an in-memory implementation of every port
    fixtures/   recorded API payloads

.github/workflows/  ingest.yml · routines.yml · ci.yml · keepalive.yml   (repo root)
```

**The dependency rule:** `domain` imports nothing. `core` imports `domain` and `ports`.
`adapters` import `ports` plus their vendor SDK. Nothing imports `adapters` except
`container.ts`.

That rule is worthless as a convention, so it is **enforced in CI** — `dependency-cruiser`
fails the build if `core/` ever imports a vendor SDK. Modularity that is only documented decays;
modularity that breaks the build does not. This is the same gate as §8, and it is the thing that
actually delivers "extending it can't break it."

`wf doctor` checks every credential and prints what is reachable. Build it first — credential
problems will otherwise dominate all early debugging.

---

## 12. Phases

| Phase | Deliverable | Why this order |
|---|---|---|
| **0** ✅ | Skeleton, CI, Jira client, `wf doctor`, Jira project + fields created | Nothing works until credentials do |
| **1** ✅ | **Slack `:ticket:` → Jira `Staged`**, end to end, plus `wf stage review` | One vertical slice proves the whole loop, gives me a working review path with no server, *and* stands up the Slack app needed in Phase 3 |
| **2** | Granola, Gmail ×N, **M365/Outlook via Graph**, Drive, Calendar, Jira mirror | Each is now just an adapter + fixtures. Graph is the long pole — do it first in this phase, and stand up §4.1's store alongside it. |
| **3** | Fly machine, Socket Mode agent, typed ops, dry-run/confirm | First time a server is actually required. **Reconsider the host here:** once this machine exists, moving cron onto it removes both the 60-day cliff and the two-writer rotation problem outright. |
| **4** | Routines + PR-authoring from Slack | Needs the agent to exist first |

---

## 13. Open items to unblock

1. **Granola plan tier** — API keys require Business. Confirm, or Phase 2 loses that source.
2. **Client secret lifetime allowed by the tenant.** Entra's ceiling is 24 months, but tenant
   policy often clamps it to 90 or 180 days. Sets how often §3.1's self-filed rotation ticket
   fires — and if it is very short, argues for a certificate rather than a secret.
3. **Remaining email accounts** — how many Gmail, and is the M365 one a tenant account or a
   personal `outlook.com` one? A personal account changes the authority URL to `/consumers`.
4. **Does Superhuman expose Outlook categories?** If not, the M365 trigger becomes "move to a
   folder" instead of "apply a category". Testable in two minutes once the account is linked.
5. **Jira** — Cloud or Server? Can I create a project and custom fields, or is that admin-gated?
6. **Slack** — can I install an app in the workspace? Needed for both the source and the agent.
   If not, Phase 1's trigger falls back to a Gmail-label-based source.
