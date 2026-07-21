#!/usr/bin/env python3
"""sdlc.py — controls for the adversarial agentic SDLC.

The append-only ledger is the source of truth. Agents do not *assert* that a gate
is satisfied; they write entries and let `gate` compute the verdict from the record.

Ledger:  .sdlc/ledger/rounds.jsonl  (append-only, one JSON object per line)
State:   .sdlc/ledger/gates.json     (derived cache; safe to delete & rebuild)

The ledger lives OUTSIDE SDLC/ (default `.sdlc/ledger/` at the repo root; override with the
`SDLC_LEDGER_DIR` env or the manifest's `ledger_dir` key) so the framework directory is fully
immutable — a submodule works as-is and a copy needs no exceptions.

Usage:
  sdlc.py open    --item AUTH-1 --title "Login throttling" [--size trivial|standard|epic]
  sdlc.py finding --item AUTH-1 --sev blocker --by adversary --msg "no lockout; brute-forceable"
  sdlc.py rebut   --ref AUTH-1-F3 --by defender --msg "rate limit is upstream at the gateway"
  sdlc.py defer   --ref AUTH-1-F4 --by defender --msg "polish; spun out as issue #12"   # minor/nit only
  sdlc.py fix     --ref AUTH-1-F3 --by builder --msg "added 5/min lockout in throttle.py"
  sdlc.py test    --ref AUTH-1-F3 --by verifier --test tests/throttle.test.js::lockout_after_5 \
                  --pre-sha abc123 --post-sha def456 --msg "fails at pre-sha, passes at post-sha; suite green"
  sdlc.py attest  --ref AUTH-1-F7 --by verifier --file tests/throttle.test.js --msg "test-oracle fix; no behavior changed"   # non-behavioral fix — no proving test possible (--kind comment to name a shipped file)
  sdlc.py verdict --ref AUTH-1-F3 --by arbiter --ruling accepted   # only for REBUTTED findings; accepted=finding valid | rejected=rebuttal wins
  sdlc.py round   --item AUTH-1 --by adversary               # mark the start of an attack round (drives the round cap)
  sdlc.py note    --item AUTH-1 --by pm --msg "PRD conformance: clean"
  sdlc.py gate    --item AUTH-1 --phase merge                # computes pass/fail from the ledger
  sdlc.py status  --item AUTH-1
  sdlc.py metrics --item AUTH-1                              # outcome & cost scorecard (omit --item for all)
  sdlc.py log     --item AUTH-1
  sdlc.py doctor                                             # validate ledger integrity (run after a merge)

Finding ids are item-scoped: `finding` mints them as <ITEM>-F<n> (e.g. AUTH-1-F3), and
every --ref must use that full id.

Escapes: a defect discovered after the item shipped is filed with `--phase post-merge`.
Post-merge findings never re-block the (already released) merge gate — they are outcome
data for `metrics`, and the fix ships through a NEW work item (the incident lane). An
escape is only accepted once the item's merge gate has actually opened: filing one on an
in-flight item would silently bypass the gate it is exempt from, so the CLI refuses it
(pass `--force` to record a deliberate operator override).

Severities: blocker > major > minor > nit.  Only blocker/major can hold a gate.

Integrity rules the CLI enforces at append time (the record must be worth trusting):
  * entry types are role-checked (`verdict` only by the arbiter, `test` only by the
    verifier, …) — see ENTRY_ROLES;
  * a `verdict` requires a prior `rebut` on the same finding: an undisputed finding
    stands as filed and needs no ruling (`--force` records an operator override);
  * a `test` entry must NAME its proving test(s) (`--test file[::name]`, repeatable)
    so CI can check they exist — an unverifiable "trust me" test claim is refused;
  * a `defer` is only valid for minor/nit findings — blockers/majors are fixed or
    rebutted, never parked.

Parallel workflows: finding ids are scoped to their work item (e.g. AUTH-1-F3), and
the ledger is a `merge=union` file (see .gitattributes). Two SDLC workflows running on
different items therefore append independently and their ledgers merge automatically,
with no id collisions. Run `sdlc.py doctor` after a merge to confirm.
"""
from __future__ import annotations
import argparse, calendar, json, os, re, signal, sys, time
from pathlib import Path

# Die quietly when a pipe consumer (head, tail) closes early, like any CLI tool.
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

BASE = Path(__file__).resolve().parent          # the SDLC/ directory
ROOT = BASE.parent                              # the repo root
MANIFEST = ROOT / "sdlc.config.json"            # the project adapter manifest (repo root)


def _manifest() -> dict:
    """The project adapter manifest (`sdlc.config.json` at the repo root) — the single place
    app/stack couplings live, read through the one shared reader (SDLC/lib/manifest.py). Missing
    or unreadable → {} so the CLI still runs on its defaults. Falls back to reading the file
    inline if manifest.py isn't importable (e.g. a test sandbox holding only sdlc.py). This is
    the CLI's ONE manifest seam — every coupling below resolves through it."""
    try:
        sys.path.insert(0, str(BASE / "lib"))
        import manifest
        return manifest.load()
    except Exception:
        try:
            return json.loads(MANIFEST.read_text())
        except Exception:
            return {}


def _shipped_paths() -> tuple[str, ...]:
    """Production-code path prefixes the build gate protects, via the one shared reader
    (`manifest.shipped_paths`) with the same env > manifest > default precedence every other
    consumer uses. Falls back to reading the manifest dict inline when the reader isn't
    importable (a sandbox holding only sdlc.py). Used by the artifact-only attestation check:
    a fix that touched a shipped path owes a proving test, never an attestation."""
    try:
        sys.path.insert(0, str(BASE / "lib"))
        import manifest
        return manifest.shipped_paths()
    except Exception:
        env = os.environ.get("SDLC_PROTECTED")
        if env:
            return tuple(p for p in env.split(":") if p)
        paths = _manifest().get("shipped_paths")
        return tuple(paths) if paths else ("src/", "server/", "worker/", "migrations/")


def _ledger_dir() -> Path:
    """The mutable ledger directory, resolved OUTSIDE SDLC/ so the framework stays immutable:
    `SDLC_LEDGER_DIR` env > manifest `ledger_dir` > default `.sdlc/ledger`, a relative value
    anchored at the repo root."""
    raw = os.environ.get("SDLC_LEDGER_DIR") or _manifest().get("ledger_dir") or ".sdlc/ledger"
    p = Path(raw)
    return p if p.is_absolute() else (ROOT / p)


LEDGER_DIR = _ledger_dir()
LEDGER = LEDGER_DIR / "rounds.jsonl"
GATES = LEDGER_DIR / "gates.json"

SEVERITIES = ("blocker", "major", "minor", "nit")
HOLDING = {"blocker", "major"}          # severities that can hold a gate shut
PHASES = ("spec", "build", "attack", "defend", "verify", "merge")

# Which roles may append which entry types. Enforced at append time only (forward-
# only): historic entries predate the rule and are reported by `doctor` as non-fatal
# notes, so an old ledger stays valid while a new session cannot mint another role's
# entries (e.g. a builder recording its own arbiter verdict or verifier test).
ENTRY_ROLES = {
    "finding": {"adversary", "pm"},
    "rebut":   {"defender"},
    "defer":   {"defender"},
    "fix":     {"builder", "architect"},   # the architect "fixes" spec-phase findings by revising the spec
    "test":    {"verifier"},
    "attest":  {"verifier"},               # verifier's artifact-only disposition — see cmd_attest
    "verdict": {"arbiter"},
    # Operator lifecycle controls: only the operator (the human) pauses/resumes/aborts a
    # cycle. Role-checked like every other entry so `doctor` flags e.g. `abort --by adversary`.
    "pause":   {"operator"},
    "resume":  {"operator"},
    "abort":   {"operator"},
}

# Framework constants — provenance + tunables, kept in ONE framework-owned data file
# (SDLC/constants.json) that travels WITH the framework code, so a port carries them unedited
# and there is a single place to read or bump them. App/stack couplings live elsewhere, in the
# repo-root sdlc.config.json. Fallbacks keep the CLI running if the file is missing.
def _constants() -> dict:
    try:
        return json.loads((BASE / "constants.json").read_text())
    except Exception:
        return {}

_CONST = _constants()
FRAMEWORK_VERSION = _CONST.get("framework_version", "unknown")
ROUND_CAP = _CONST.get("round_cap", 4)              # max adversarial rounds before escalation
FINDING_BUDGET = _CONST.get("finding_budget", 8)    # soft cap on findings/round — warn, never block

# Schema epoch: the instant the append-time integrity rules (role checks, verdict-
# requires-rebut, named-and-anchored tests, known gate phases) became enforced. The
# grandfathering of older ledgers is bounded, not open-ended: `doctor` reports an
# anomaly in an entry recorded BEFORE the epoch as a non-fatal note (a legacy ledger
# stays valid), but an anomaly in an entry recorded AT OR AFTER it is a FATAL integrity
# problem. What the bound actually buys: it stops the grandfathering from being open-ended,
# so an ACCIDENTAL new anomaly (a fresh entry that slips a rule) is caught as fatal instead
# of excused as legacy. It is NOT a forgery defense — `ts` is self-reported, so someone
# hand-writing the ledger around the CLI can date an entry pre-epoch (or omit `ts`) to route
# it back to a non-fatal note. That case is caught elsewhere: the CI append-only diff shows
# the hand-edit, and the role/verdict rules still read wrong. Entries with no timestamp
# (hand-written/legacy) are treated as pre-epoch.
SCHEMA_EPOCH = _CONST.get("schema_epoch", "2026-07-05T00:00:00Z")

# A phase gate cannot open until every phase behind it has already opened. The
# merge gate is the release gate for the WHOLE engineering pipeline, so it stays
# shut until the spec (technical spec + plan) is ratified, the build is recorded,
# and at least one adversarial round has run — not just until the findings raised
# so far are resolved.
# (The product workflow — the PRD — is human-only, runs on the issue, and never touches this ledger.)
PREREQ_GATES = {"build": ("spec",), "merge": ("spec", "build")}
ROUNDS_REQUIRED = {"merge": 1}          # phases that require >=N recorded rounds


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _epoch(ts: str) -> int:
    """Parse a ledger UTC timestamp ('...Z') to epoch seconds."""
    return calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ"))


def _fmt_dur(secs: int) -> str:
    """Human-friendly duration: '45s', '12m', '1h04m'."""
    secs = max(0, int(secs))
    if secs < 90:
        return f"{secs}s"
    mins = (secs + 30) // 60                  # round to the nearest minute
    if mins < 60:
        return f"{mins}m"
    h, m = divmod(mins, 60)
    return f"{h}h{m:02d}m"


# Reportable phases (the product workflow is human-only, lives on the issue, and never
# touches the ledger).
# Each: (label, start-anchor, end-gate). Timing reports each completed phase's active
# span (anchor → gate) minus operator wait; per-role sub-attribution was dropped — it
# rested on fragile gap heuristics and served only a vanity table.
TIMING_PHASES = (
    ("SPEC",  "open",  "spec"),
    ("BUILD", "spec",  "build"),
    ("TEST",  "build", "merge"),
)


MALFORMED: list[str] = []       # unparseable ledger lines from the last _read(), for doctor


def _read() -> list[dict]:
    """Parseable ledger entries. A line that isn't valid JSON (a mangled hand-merge, a
    stray conflict marker) is collected in MALFORMED instead of crashing the CLI, so every
    command still runs on the healthy entries and `doctor` reports each bad line as a
    FATAL integrity problem — a diagnosis, not a traceback."""
    if not LEDGER.exists():
        return []
    MALFORMED.clear()
    out = []
    for n, line in enumerate(LEDGER.read_text().splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            MALFORMED.append(f"line {n}: {line[:60]!r}")
    return out


def _append(entry: dict) -> dict:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    entry = {"ts": _now(), **entry}
    with LEDGER.open("a") as f:
        f.write(json.dumps(entry, sort_keys=False) + "\n")
    return entry


def _post_epoch(entry: dict) -> bool:
    """True if the entry was recorded at or after the schema epoch, so append-time
    integrity rules apply to it as fatal. Entries with no ts (hand-written or legacy)
    or an older ts are grandfathered (pre-epoch)."""
    ts = entry.get("ts")
    if not ts:
        return False
    try:
        return _epoch(ts) >= _epoch(SCHEMA_EPOCH)
    except Exception:
        return False


def _require_role(entry_type: str, by: str):
    """Refuse an append whose --by is not a role allowed to write this entry type."""
    allowed = ENTRY_ROLES.get(entry_type)
    if allowed and by not in allowed:
        sys.exit(f"{entry_type} entries must be recorded by {'/'.join(sorted(allowed))} "
                 f"(got --by {by!r}) — the record only means something if roles stay separate")


def _next_finding_id(entries: list[dict], item: str) -> str:
    """Mint the next finding id, scoped to its work item: e.g. ISSUE-7-F3.

    Counting per item (not globally) is what keeps ids collision-free when two SDLC
    workflows run in parallel on different items: each branch numbers within its own
    item, so a union-merge of the two ledgers can never produce two findings that
    share an id. (Historic global-numbered ids like "F5" still resolve by exact
    match, so mixing old and new ids in one ledger is safe.)"""
    n = sum(1 for e in entries
            if e.get("type") == "finding" and e.get("item") == item) + 1
    return f"{item}-F{n}"


# ---- commands ---------------------------------------------------------------

SIZES = ("trivial", "standard", "epic")
# Size drives the workflows' path, not the gate math: trivial skips the PRD iteration
# and uses a mini-spec (one human checkpoint, one diff-scoped round); standard is the
# full cycle; epic must be split into child issues before engineering starts (an epic
# never builds directly). The ledger state machine is identical for all three — size is
# recorded so the path taken is auditable and `metrics` can compare cost by size.


def cmd_open(a):
    if a.size not in SIZES:
        sys.exit(f"size must be one of {SIZES}")
    e = _append({"type": "open", "item": a.item, "title": a.title,
                 "phase": "spec", "size": a.size})
    print(f"opened {a.item} [{a.size}]: {a.title}")
    return e


def cmd_finding(a):
    if a.sev not in SEVERITIES:
        sys.exit(f"severity must be one of {SEVERITIES}")
    _require_role("finding", a.by)
    entries = _read()
    if a.phase == "post-merge" and not _merge_released(entries, a.item) and not a.force:
        sys.exit(f"{a.item} has no open merge gate — a post-merge finding records a defect that "
                 f"ALREADY shipped and is excluded from gate math. Filing one before the item is "
                 f"released would silently bypass the merge gate. File it as a normal finding, or "
                 f"pass --force to record a deliberate operator override.")
    fid = _next_finding_id(entries, a.item)
    e = {"type": "finding", "id": fid, "item": a.item, "sev": a.sev,
         "by": a.by, "msg": a.msg, "state": "open"}
    if a.phase:
        e["phase"] = a.phase
    if a.phase == "post-merge" and a.force:
        e["forced"] = True
    _append(e)
    print(f"filed {fid} [{a.sev}] on {a.item}: {a.msg}")
    if a.phase == "post-merge":
        return                     # an escape is outcome data, not part of a round's budget
    # Soft adversary budget: filing is cheap but every finding costs a defend/verify
    # round-trip, so past the budget the CLI pushes back (warn only, never block).
    round_ts = [x["ts"] for x in entries
                if x.get("type") == "round" and x.get("item") == a.item]
    since = max(_epoch(t) for t in round_ts) if round_ts else None
    n_round = sum(1 for x in entries
                  if x.get("type") == "finding" and x.get("item") == a.item
                  and (since is None or _epoch(x["ts"]) >= since)) + 1
    if n_round > FINDING_BUDGET:
        print(f"⚠ {n_round} findings this round (budget {FINDING_BUDGET}) — rank by severity and "
              f"file only what you can defend; rejected volume counts against the adversary.",
              file=sys.stderr)


def cmd_rebut(a):
    _require_role("rebut", a.by)
    _append({"type": "rebut", "ref": a.ref, "by": a.by, "msg": a.msg})
    print(f"rebuttal recorded against {a.ref}")


def cmd_defer(a):
    """Park a minor/nit outside the merge round (follow-up issue), on the record.
    Minors never held a gate anyway; deferring keeps them out of the merge diff
    instead of silently inflating it. Blockers/majors cannot be deferred."""
    _require_role("defer", a.by)
    entries = _read()
    f = next((e for e in entries if e.get("type") == "finding" and e.get("id") == a.ref), None)
    if not f:
        sys.exit(f"unknown finding {a.ref!r}")
    if f.get("sev") in HOLDING:
        sys.exit(f"{a.ref} is a {f['sev']} — blockers/majors are fixed or rebutted, never deferred")
    _append({"type": "defer", "ref": a.ref, "by": a.by, "msg": a.msg})
    print(f"deferred {a.ref} to follow-up: {a.msg}")


def cmd_fix(a):
    _require_role("fix", a.by)
    _append({"type": "fix", "ref": a.ref, "by": a.by, "msg": a.msg})
    print(f"fix recorded for {a.ref}")


def cmd_test(a):
    _require_role("test", a.by)
    if not a.tests:
        sys.exit("a proving test must be named: --test <file[::test name]> (repeatable) — "
                 "CI checks the named tests exist, so an unverifiable claim is refused")
    if not a.pre_sha or not a.post_sha:
        sys.exit("the proof must be anchored: --pre-sha <commit where the test FAILED> and "
                 "--post-sha <commit where it PASSED> are both required — an unanchored "
                 "'fails pre-fix' claim can't be re-executed, so it proves nothing")
    e = {"type": "test", "ref": a.ref, "by": a.by, "msg": a.msg, "tests": a.tests,
         "pre_sha": a.pre_sha, "post_sha": a.post_sha}
    _append(e)
    print(f"proving test recorded for {a.ref}: {', '.join(a.tests)}")


def cmd_attest(a):
    """The verifier's disposition that a finding's fix changed **no product behavior**, so a
    fail-then-pass proving test is structurally void — exactly as a spec revision needs none.
    It resolves the finding like a spec-phase one.

    The proving-test machinery (`spot_check.py`) verifies a fix by checking out the PRE-FIX
    *code* and proving the named test flips fail→pass across it. That model is defined over
    fixes that change behavior. When the fix changed none — a test's oracle, a doc, or a
    comment/docstring inside product code — the test would pass at the pre-fix commit and the
    claim reads as disproven. Such a fix records an attestation, NOT a fabricated `test` entry.

    Honesty is checkable where it can be. The attestation NAMES the file(s) the fix touched:
      • files OUTSIDE `shipped_paths` (a test oracle, a doc) — self-evidently non-behavioral;
        the file location IS the proof, and CI confirms each is a real file.
      • a comment/docstring change INSIDE `shipped_paths` is also untestable, but 'the diff is
        comment-only' is not mechanically decidable — so it must be recorded with
        `--kind comment` (an explicit non-behavioral claim) and CI FLAGS it for the arbiter /
        human to confirm at merge-ready. A shipped file named WITHOUT `--kind comment` is
        refused: a behavioral fix owes a proving test.

    (A strengthened test oracle can also be proven for real by a mutation note in --msg — the
    corrected test fails when the finding's specific weakness is re-introduced — but that needs
    a mutant the framework doesn't require elsewhere, so the attestation is the floor.)"""
    _require_role("attest", a.by)
    if not a.files:
        sys.exit("an attestation must name the fix's file(s): --file <path> (repeatable) — CI "
                 "confirms each is a real file, so a bare claim is refused")
    e = {"type": "attest", "ref": a.ref, "by": a.by, "files": a.files, "msg": a.msg}
    if getattr(a, "kind", None):
        e["kind"] = a.kind
    _append(e)
    print(f"attestation recorded for {a.ref}: {', '.join(a.files)}"
          + (f" [kind={a.kind}]" if getattr(a, "kind", None) else ""))


def cmd_verdict(a):
    if a.ruling not in ("accepted", "rejected"):
        sys.exit("ruling must be 'accepted' or 'rejected'")
    _require_role("verdict", a.by)
    entries = _read()
    if not a.force and not any(e.get("type") == "rebut" and e.get("ref") == a.ref for e in entries):
        sys.exit(f"no rebuttal on record for {a.ref} — an undisputed finding stands as filed and "
                 f"needs no verdict (fix+prove it, rebut it first, or pass --force to record an "
                 f"explicit operator override)")
    e = {"type": "verdict", "ref": a.ref, "by": a.by, "ruling": a.ruling, "msg": a.msg or ""}
    if a.force:
        e["forced"] = True
    _append(e)
    print(f"arbiter ruled {a.ref}: {a.ruling}")


def cmd_round(a):
    """Mark the start of an ATTACK→DEFEND→VERIFY round. Drives the round cap honestly:
    one event per actual round, not one per finding."""
    entries = _read()
    n = sum(1 for e in entries if e.get("type") == "round" and e.get("item") == a.item) + 1
    _append({"type": "round", "item": a.item, "n": n, "by": a.by, "msg": a.msg or ""})
    print(f"round {n} opened on {a.item}" + (f" / cap {ROUND_CAP}" if n >= ROUND_CAP else ""))


def cmd_version(a):
    """Print the framework version + schema epoch — provenance markers baked into the
    framework code (not the app manifest), so a port says which revision it froze at when
    reconciling against upstream fixes."""
    print(f"sdlc framework {FRAMEWORK_VERSION} (schema epoch {SCHEMA_EPOCH})")
    return FRAMEWORK_VERSION


def cmd_note(a):
    """A recorded observation tied to an item — e.g. the pm's mandatory
    PRD-conformance result ('clean' or a pointer at the findings it filed)."""
    _append({"type": "note", "item": a.item, "by": a.by, "msg": a.msg})
    print(f"noted on {a.item} by {a.by}: {a.msg}")


def cmd_pause(a):
    """Operator pause: an explicit, ledger-recorded lifecycle control. Because `state`
    reads it (see _control_state), pausing is a real resumable state — a session that
    re-derives `state` on wake (including a takeover session, driver §1) sees the pause
    instead of driving straight through it."""
    _require_role("pause", a.by)
    _append({"type": "pause", "item": a.item, "by": a.by, "msg": a.msg or ""})
    print(f"paused {a.item}" + (f": {a.msg}" if a.msg else "") + " — resume to continue")


def cmd_resume(a):
    _require_role("resume", a.by)
    _append({"type": "resume", "item": a.item, "by": a.by, "msg": a.msg or ""})
    print(f"resumed {a.item}")


def cmd_abort(a):
    """Operator abort: a terminal lifecycle control. `state` reports the item as
    aborted thereafter so no session re-drives it."""
    _require_role("abort", a.by)
    _append({"type": "abort", "item": a.item, "by": a.by, "msg": a.msg or ""})
    print(f"aborted {a.item}" + (f": {a.msg}" if a.msg else ""))


def _control_state(entries: list[dict], item: str) -> str | None:
    """Operator lifecycle control derived from the ledger: 'aborted' if the cycle was
    ever aborted (terminal), else 'paused' if the most recent pause/resume for the item
    is a pause, else None. Pause/resume/abort are single-session operator actions (never
    two parallel branches racing on the same item), so file order is authoritative here."""
    if any(e.get("type") == "abort" and e.get("item") == item for e in entries):
        return "aborted"
    latest = None
    for e in entries:
        if e.get("type") in ("pause", "resume") and e.get("item") == item:
            latest = e.get("type")
    return "paused" if latest == "pause" else None


def _resolve(entries: list[dict], item: str):
    """Return findings reconstructed from the ledger for one item."""
    findings = {}
    for e in entries:
        if e.get("type") == "finding" and e.get("item") == item:
            findings[e["id"]] = {**e, "fixed": False, "tested": False, "attested": False,
                                 "rebutted": False, "deferred": False, "ruling": None}
    for e in entries:
        ref = e.get("ref")
        if ref not in findings:
            continue
        t = e["type"]
        if t == "fix":
            findings[ref]["fixed"] = True
        elif t == "test":
            findings[ref]["tested"] = True
        elif t == "attest":
            findings[ref]["attested"] = True
        elif t == "rebut":
            findings[ref]["rebutted"] = True
        elif t == "defer":
            findings[ref]["deferred"] = True
        elif t == "verdict":
            findings[ref]["ruling"] = e["ruling"]
    return findings


def _latest_gate(entries: list[dict], item: str, phase: str):
    """Most recent recorded result for an (item, phase) gate: 'open' | 'blocked' | None."""
    result = None
    for e in entries:
        if e.get("type") == "gate" and e.get("item") == item and e.get("phase") == phase:
            result = e.get("result")
    return result


def _first_gate_open_ts(entries: list[dict], item: str, phase: str):
    """Earliest 'open' for an (item, phase) gate — order-independent (min by time)."""
    opens = [e["ts"] for e in entries
             if e.get("type") == "gate" and e.get("item") == item
             and e.get("phase") == phase and e.get("result") == "open"]
    return min(opens, key=_epoch) if opens else None


def _merge_released(entries: list[dict], item: str) -> bool:
    """True once the item's merge gate has opened at least once — i.e. it shipped.
    An escape (a `post-merge` finding) is only meaningful after release; before it,
    a post-merge finding would be excluded from gate math while the gate is still
    live, silently bypassing it."""
    return _first_gate_open_ts(entries, item, "merge") is not None


def _missing_prereqs(entries: list[dict], item: str, phase: str, rounds: int):
    """Phases that must already have passed before `phase` may open but haven't.
    Returns a list of human-readable prerequisite labels still outstanding."""
    missing = []
    for prior in PREREQ_GATES.get(phase, ()):
        if _latest_gate(entries, item, prior) != "open":
            missing.append(prior)
    need_rounds = ROUNDS_REQUIRED.get(phase, 0)
    if rounds < need_rounds:
        missing.append(f"round (>={need_rounds}, have {rounds})")
    return missing


def _dirty_round(entries: list[dict], item: str) -> bool:
    """True when blocker/major findings were filed in the latest recorded round —
    i.e. the round is not clean, so the fixes it produced have never themselves been
    attacked. The merge gate requires the FINAL round to be clean (computed here, not
    asserted by the arbiter): find blockers → fix them → a fresh round must survey the
    fixes and file nothing blocker/major before the gate can open."""
    round_ts = [e["ts"] for e in entries
                if e.get("type") == "round" and e.get("item") == item]
    if not round_ts:
        return False
    latest = max(_epoch(t) for t in round_ts)
    return any(e.get("type") == "finding" and e.get("item") == item
               and e.get("sev") in HOLDING and _epoch(e["ts"]) >= latest
               and e.get("phase") != "post-merge"
               for e in entries)


def _gate_status(entries: list[dict], item: str, phase: str | None = None):
    findings = _resolve(entries, item)
    spec_open = _first_gate_open_ts(entries, item, "spec")
    unresolved = []
    for fid, f in findings.items():
        if f["sev"] not in HOLDING:
            continue
        if f.get("phase") == "post-merge":  # an escape: outcome data for `metrics`, resolved
            continue                        # through a new item (incident lane) — the merge
                                            # gate it would hold has already released
        ruling = f["ruling"]
        if ruling == "rejected":            # rebuttal won — not holding
            continue
        # A spec-phase finding is resolved by a spec revision alone: no proving test
        # exists for a document (requiring one forced fabricated 'test' entries).
        # Classified by an explicit phase tag, else by time — filed before the spec
        # gate first opened, or filed while the spec gate is being evaluated.
        is_spec = (f.get("phase") == "spec"
                   or (spec_open is not None and _epoch(f["ts"]) <= _epoch(spec_open))
                   or (spec_open is None and phase == "spec"))
        # Proven when fixed AND one of: a proving test; a spec revision (no test exists for a
        # document); an artifact-only attestation (the fix touched no product code, so the
        # fail→pass model is structurally void — cmd_attest). CI checks each attestation is
        # honest (names real, non-product files) the same way it checks named tests exist.
        if f["fixed"] and (f["tested"] or is_spec or f["attested"]):   # fixed and proven — resolved
            continue
        if f["rebutted"] and ruling is None:  # disputed, arbiter hasn't ruled
            unresolved.append((fid, f, "awaiting arbiter ruling"))
            continue
        need = "fix (spec revision)" if is_spec else "fix+test (or an artifact-only attestation)"
        why = f"accepted, awaiting {need}" if ruling == "accepted" else f"awaiting {need}"
        unresolved.append((fid, f, why))
    return findings, unresolved


def cmd_gate(a):
    entries = _read()
    findings, unresolved = _gate_status(entries, a.item, a.phase)
    rounds = sum(1 for e in entries if e.get("type") == "round" and e.get("item") == a.item)
    missing = _missing_prereqs(entries, a.item, a.phase, rounds)
    dirty = a.phase == "merge" and _dirty_round(entries, a.item)
    passed = len(unresolved) == 0 and len(missing) == 0 and not dirty
    _save_gate(a.item, a.phase, passed)
    entry = {"type": "gate", "item": a.item, "phase": a.phase,
             "result": "open" if passed else "blocked",
             "unresolved": [u[0] for u in unresolved],
             "missing_phases": missing}
    if dirty:
        entry["dirty_round"] = True
    _append(entry)
    print(f"\nGATE [{a.phase}] for {a.item}: {'✅ OPEN' if passed else '⛔ BLOCKED'}")
    if missing:
        print(f"  {len(missing)} prior phase(s) not yet passed: {', '.join(missing)}")
        print(f"    (the {a.phase} gate stays shut until every phase behind it is green)")
    if dirty:
        print("  latest round filed blocker/major findings — the fixes must survive a clean")
        print("  re-attack round (scoped to the fix diff) before the merge gate can open")
    if unresolved:
        print(f"  {len(unresolved)} holding finding(s):")
        for fid, f, why in unresolved:
            print(f"    {fid} [{f['sev']}] {why} — {f['msg']}")
    if rounds >= ROUND_CAP:
        print(f"  ⚠ round cap reached ({rounds}/{ROUND_CAP}) — escalate to human operator")
    if getattr(a, "exit_code", False) and not passed:
        sys.exit(1)              # for CI: fail the status check when the gate is blocked
    return passed


def _save_gate(item, phase, passed):
    state = json.loads(GATES.read_text()) if GATES.exists() else {}
    state.setdefault(item, {})[phase] = {"open": passed, "ts": _now()}
    GATES.parent.mkdir(parents=True, exist_ok=True)
    GATES.write_text(json.dumps(state, indent=2))


def _check_append_only(base_sha: str) -> bool:
    """The ledger is append-only: relative to the merge base, the PR may only ADD lines to
    rounds.jsonl. Diffs commits (not the working tree), so a later in-run gate append is
    invisible here. Returns True when clean."""
    import subprocess
    rel = str(LEDGER.relative_to(ROOT))              # e.g. .sdlc/ledger/rounds.jsonl
    mb = subprocess.run(["git", "merge-base", base_sha, "HEAD"], capture_output=True, text=True)
    merge_base = (mb.stdout.strip() or base_sha)
    r = subprocess.run(["git", "diff", "--numstat", merge_base, "HEAD", "--", rel],
                       capture_output=True, text=True)
    deleted = 0
    for line in r.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) >= 2 and cols[1].isdigit():
            deleted += int(cols[1])
    if deleted:
        print(f"::error title=arbiter-gate::{rel} removes or rewrites {deleted} line(s) vs the "
              f"merge base — the ledger is append-only")
        return False
    print(f"✅ ledger diff is append-only ({merge_base[:12]}..HEAD)")
    return True


def _check_tests_exist(item: str) -> bool:
    """Every proving test the ledger names for this item (`--test file[::name]`) must exist in
    the tree — a `test` entry is a claim, and this makes it checkable. Returns True when all
    named tests are present."""
    root = BASE.parent
    bad = []
    for e in _read():
        if e.get("type") != "test" or not e.get("tests"):
            continue
        ref = e.get("ref", "")
        if not (ref == item or ref.startswith(item + "-")):
            continue
        for t in e["tests"]:
            path, _, name = t.partition("::")
            p = root / path
            if not p.is_file():
                bad.append(f"{ref}: named test file {path!r} does not exist")
            elif name and name not in p.read_text():
                bad.append(f"{ref}: test {name!r} not found in {path}")
    if bad:
        print("::error title=arbiter-gate::ledger names proving tests that do not exist")
        for b in bad:
            print("  -", b)
        return False
    print("✅ every proving test named in the ledger exists in the tree")
    return True


def _check_attestations(item: str) -> bool:
    """The mechanical honesty check behind `attest`. A proving test is required exactly when
    product BEHAVIOR changed — not merely when a shipped file was touched — so the check turns
    on that, not on file location alone:

      - every named file must EXIST (a phantom file is refused);
      - a file OUTSIDE `shipped_paths` (a test oracle, a doc) is self-evidently non-behavioral
        — the location is the proof;
      - a file INSIDE `shipped_paths` is a comment/docstring change to product code: also
        untestable, but 'the diff is comment-only' is NOT mechanically decidable, so it must
        carry `kind: comment` and is FLAGGED (::warning) for the arbiter/human to confirm at
        merge-ready. A shipped file named without `kind: comment` is REFUSED — a behavioral
        fix owes a proving test.

    Returns False (fails the gate) only on a hard violation; a flagged comment attestation
    passes with a warning."""
    root = BASE.parent
    shipped = tuple(sp if sp.endswith("/") else sp + "/" for sp in _shipped_paths())
    bad, flagged = [], []
    for e in _read():
        if e.get("type") != "attest":
            continue
        ref = e.get("ref", "")
        if not (ref == item or ref.startswith(item + "-")):
            continue
        files = e.get("files") or []
        if not files:
            bad.append(f"{ref}: attestation names no file")
            continue
        is_comment = e.get("kind") == "comment"
        for f in files:
            norm = f.lstrip("./")
            if not (root / f).is_file():
                bad.append(f"{ref}: attested file {f!r} does not exist at HEAD")
            elif any(norm.startswith(sp) for sp in shipped):
                if is_comment:
                    flagged.append(f"{ref}: {f} (product file, kind=comment — the arbiter/human "
                                   f"must confirm the change is non-behavioral)")
                else:
                    bad.append(f"{ref}: attested file {f!r} is under a shipped path without "
                               f"kind=comment — a behavioral fix owes a proving test; a "
                               f"comment/docstring-only change records `--kind comment`")
    if bad:
        print("::error title=arbiter-gate::an attestation names a missing file or an unqualified product file")
        for b in bad:
            print("  -", b)
        return False
    for fl in flagged:
        print(f"::warning title=arbiter-gate::comment-only product attestation, confirm non-behavioral — {fl}")
    print("✅ every attestation names real files"
          + (f"; {len(flagged)} comment-only product attestation(s) flagged for review" if flagged
             else ", all non-product"))
    return True


def cmd_verify_gate(a):
    """CI entry point: run every LEDGER-SEMANTIC gate check in one call so the workflow stays a
    thin orchestrator — integrity (`doctor`), append-only (needs `--base`), proving-tests-exist,
    and the merge-gate computation. Emits ::error annotations; exits 1 if any check fails."""
    from types import SimpleNamespace
    ok = True
    print("== ledger integrity (doctor) ==")
    ok = cmd_doctor(SimpleNamespace(exit_code=False)) and ok
    if getattr(a, "base", ""):
        print("\n== ledger append-only ==")
        ok = _check_append_only(a.base) and ok
    print("\n== proving tests named in the ledger exist ==")
    ok = _check_tests_exist(a.item) and ok
    print("\n== artifact-only attestations are non-product ==")
    ok = _check_attestations(a.item) and ok
    print("\n== MERGE gate ==")
    cmd_status(SimpleNamespace(item=a.item))
    ok = cmd_gate(SimpleNamespace(item=a.item, phase="merge", exit_code=False)) and ok
    print()
    if not ok:
        print("⛔ verify-gate: one or more ledger checks failed")
        sys.exit(1)
    print("✅ verify-gate: all ledger checks passed")


def cmd_status(a):
    entries = _read()
    findings, unresolved = _gate_status(entries, a.item)
    print(f"\n{a.item} — {len(findings)} finding(s) on record")
    for fid, f in findings.items():
        flags = "".join([
            "F" if f["fixed"] else "-",
            "T" if f["tested"] else "-",
            "A" if f["attested"] else "-",
            "R" if f["rebutted"] else "-",
            "D" if f["deferred"] else "-",
        ])
        ruling = f["ruling"] or "pending"
        print(f"  {fid} [{f['sev']:7}] {flags} {ruling:9} {f['msg']}")
    print(f"\n  holding the next gate: {[u[0] for u in unresolved] or 'none — clear'}")


def cmd_log(a):
    for e in _read():
        if a.item and e.get("item") != a.item and e.get("ref", "").startswith("F"):
            # show item-scoped plus refs; keep it simple — print all when no item filter
            pass
        if (not a.item) or e.get("item") == a.item or "ref" in e:
            print(json.dumps(e))


def cmd_doctor(a):
    """Validate ledger integrity — run after merging parallel branches.

    A union-merge of two well-formed ledgers is always valid, but this catches the
    pathological cases (e.g. two workflows that ran on the *same* item, or a
    hand-merge that dropped a line): duplicate finding ids and references to
    findings that don't exist. Exit 1 with --exit-code so CI can gate on it.

    Schema anomalies (role violations, verdict-without-rebut, unknown gate phases,
    test entries that name no test) are routed by the schema epoch: an anomaly in a
    pre-epoch entry is a grandfathered non-fatal note (historic ledgers stay valid),
    while one in a post-epoch entry is a FATAL problem — a violation the CLI refuses to
    mint, so its presence means the ledger was written around the CLI. See SCHEMA_EPOCH."""
    entries = _read()
    problems = []

    for bad in MALFORMED:
        problems.append(f"unparseable ledger {bad} — not JSON (mangled merge or hand edit)")

    seen: dict[str, list[str]] = {}
    for e in entries:
        if e.get("type") == "finding":
            seen.setdefault(e.get("id", ""), []).append(e.get("item", "?"))
    for fid, items in seen.items():
        if len(items) > 1:
            problems.append(
                f"duplicate finding id {fid} on items {items} — "
                f"likely a parallel-branch collision (same item run twice?)")

    # Valid ref targets are finding ids plus known item ids: a fix/test may reference
    # the item itself to record build-phase work (not a finding). Anything else is a
    # dangling ref — a sign a merge dropped the finding line it pointed at.
    items = {e.get("item") for e in entries if e.get("item")}
    valid = set(seen) | items
    for e in entries:
        ref = e.get("ref")
        if ref and ref not in valid:
            problems.append(f"{e.get('type')} references unknown finding {ref!r}")

    # An escape (post-merge finding) must reference an item that actually shipped — its
    # gate exemption is only sound once the merge gate has opened. The CLI refuses a
    # premature one at append time; catch a hand-edited or un-forced one on the record.
    merged = {e.get("item") for e in entries if e.get("type") == "gate"
              and e.get("phase") == "merge" and e.get("result") == "open"}
    for e in entries:
        if (e.get("type") == "finding" and e.get("phase") == "post-merge"
                and not e.get("forced") and e.get("item") not in merged):
            problems.append(f"post-merge finding {e.get('id')} on {e.get('item')} whose merge gate "
                            f"never opened — a premature escape bypasses the merge gate it is exempt from")

    notes = []

    def anomaly(e, msg):
        """Route a schema anomaly by the entry's epoch: fatal problem if the entry was
        recorded after the rules took effect, else a grandfathered non-fatal note."""
        (problems if _post_epoch(e) else notes).append(
            msg + (" [post-epoch: written around the CLI]" if _post_epoch(e) else ""))

    rebutted = {e.get("ref") for e in entries if e.get("type") == "rebut"}
    for e in entries:
        t = e.get("type", "")
        allowed = ENTRY_ROLES.get(t)
        if allowed and e.get("by") not in allowed:
            anomaly(e, f"{t} by {e.get('by')!r} (expected {'/'.join(sorted(allowed))}) "
                       f"on {e.get('ref') or e.get('id') or e.get('item')}")
        if t == "gate" and e.get("phase") not in PHASES:
            anomaly(e, f"gate with unknown phase {e.get('phase')!r} on {e.get('item')}")
        if t == "test" and not e.get("tests"):
            anomaly(e, f"test entry on {e.get('ref')} names no --test (unverifiable claim)")
        if t == "attest" and not e.get("files"):
            anomaly(e, f"attest entry on {e.get('ref')} names no --file (unverifiable claim)")
        if t == "verdict" and not e.get("forced") and e.get("ref") not in rebutted:
            anomaly(e, f"verdict on {e.get('ref')} has no prior rebut "
                       f"(an undisputed finding stands as filed and needs no ruling)")
    for item in sorted(i for i in items if i):
        for ref in _defer_debt(entries, item):
            notes.append(f"defer {ref} has no follow-up issue (#N) in its message or a later "
                         f"note — deferred work must be tracked, not dropped")

    if problems:
        print(f"⛔ ledger has {len(problems)} integrity problem(s):")
        for p in problems:
            print(f"  - {p}")
    else:
        n_find = len(seen)
        print(f"✅ ledger OK — {len(entries)} entries, {n_find} findings, no id collisions or dangling refs")
    if notes:
        print(f"ℹ {len(notes)} schema note(s) (non-fatal; legacy entries are grandfathered):")
        for n in notes[:10]:
            print(f"  - {n}")
        if len(notes) > 10:
            print(f"  … and {len(notes) - 10} more")
    if problems and getattr(a, "exit_code", False):
        sys.exit(1)
    return not problems


def _next_action(entries: list[dict], item: str) -> tuple[str, str]:
    """Derive the next enabled engineering step from the ledger alone.

    The engineering cycle is a linear state machine — spec → build → test → merge — and
    each run recomputes 'where are we' from the record rather than trusting session memory.
    This is what makes the ephemeral, event-driven runs *resumable*: any run (or re-run
    after a crash) reads the same authoritative state and continues from the one enabled
    transition. Returns (action, why). Actions:
      spec              — spec gate not yet open (write/ratify the spec)
      build             — spec ratified; build not yet recorded
      test              — build done but no clean round yet (run/continue the attack loop)
      merge             — a clean final round: no holding findings, ready for the merge gate
      done              — merge gate already open (PR ready for a human to merge)
      blocked:roundcap  — holding findings remain at the round cap; escalate to a human
      paused            — operator paused the cycle; do no work until `@claude resume`
      aborted           — operator aborted the cycle (terminal)

    Operator controls are checked first: a pause or abort overrides the engineering
    state so a resuming (or taking-over) session never drives through it.
    """
    control = _control_state(entries, item)
    if control == "aborted":
        return "aborted", "cycle aborted by the operator (terminal)"
    if control == "paused":
        return "paused", "operator paused the cycle — resume to continue"
    if _latest_gate(entries, item, "spec") != "open":
        return "spec", "spec gate not open"
    if _latest_gate(entries, item, "build") != "open":
        return "build", "spec ratified; build not recorded"
    rounds = sum(1 for e in entries if e.get("type") == "round" and e.get("item") == item)
    if rounds == 0:
        return "test", "build done; no adversarial round yet"
    if _latest_gate(entries, item, "merge") == "open":
        return "done", "merge gate open — PR ready for review"
    _, unresolved = _gate_status(entries, item)
    if unresolved:
        if rounds >= ROUND_CAP:
            return "blocked:roundcap", f"{len(unresolved)} holding finding(s) at round cap {ROUND_CAP}"
        return "test", f"{len(unresolved)} holding finding(s) — another round"
    if _dirty_round(entries, item):
        if rounds >= ROUND_CAP:
            return "blocked:roundcap", f"round cap {ROUND_CAP} reached with no clean final round"
        return "test", "latest round filed blocker/major findings — re-attack round required"
    return "merge", "clean round — open the merge gate"


def cmd_state(a):
    """Print the next enabled engineering step, derived from the ledger (see _next_action).
    With --item, the last stdout line is `next=<action>` — the driver's contract.
    Without --item: one line per known item (the operator's cross-item view)."""
    entries = _read()
    if not a.item:
        items = sorted({e["item"] for e in entries if e.get("item")})
        if not items:
            print("no work items on record")
            return None
        for item in items:
            action, why = _next_action(entries, item)
            size = next((e.get("size") for e in entries
                         if e.get("type") == "open" and e.get("item") == item and e.get("size")), None)
            print(f"{item:12} {f'[{size}]':10} next={action:16} — {why}" if size
                  else f"{item:12} {'':10} next={action:16} — {why}")
        return None
    action, why = _next_action(entries, a.item)
    size = next((e.get("size") for e in entries
                 if e.get("type") == "open" and e.get("item") == a.item and e.get("size")), None)
    print(f"{a.item}{f' [{size}]' if size else ''}: {why}")
    print(f"next={action}")
    return action


def cmd_await(a):
    """Mark that the cycle is now waiting for operator input (e.g. `@claude continue` at
    the spec checkpoint). The driver logs this as its last action before stopping; `timing`
    treats the gap from here to the next recorded event as operator wait, keeping it out of
    the active per-phase numbers."""
    _append({"type": "await", "item": a.item, "for": a.reason})
    print(f"awaiting operator on {a.item}" + (f": {a.reason}" if a.reason else ""))


def _phase_durations(entries: list[dict]) -> list[tuple[str, int, int]]:
    """(label, active_secs, waited_secs) for each *completed* phase of one item's
    entries (pre-filtered to the item). Only phases whose gate has opened are
    reported, so the numbers are stable and resume-proof. Shared by `timing` and
    `metrics`."""
    if not entries:
        return []

    def gate_ts(phase):
        # The *first* time a gate opened is when its phase actually completed. The
        # resumable state machine re-derives and re-emits gate events on every resume,
        # so a phase's gate is re-confirmed 'open' long after the phase finished — often
        # across hours of operator/idle wait. Anchoring on the last open would drag the
        # phase boundary forward over that idle time and inflate the active numbers;
        # anchoring on the first open is both correct and resume-proof (it never moves).
        for e in entries:
            if e.get("type") == "gate" and e.get("phase") == phase and e.get("result") == "open":
                return e["ts"]
        return None

    anchors = {"open": next((e["ts"] for e in entries if e.get("type") == "open"), entries[0]["ts"]),
               "spec": gate_ts("spec"), "build": gate_ts("build"), "merge": gate_ts("merge")}

    out = []
    for label, start_key, end_key in TIMING_PHASES:
        start, end = anchors[start_key], anchors[end_key]
        if not start or not end:
            continue                                    # phase not complete — skip
        s, en = _epoch(start), _epoch(end)
        if en <= s:
            continue                                    # boundaries cross (out-of-order gates) — skip
        within = sorted((e for e in entries if s < _epoch(e["ts"]) <= en),
                        key=lambda e: _epoch(e["ts"]))
        waited, prev, prev_await = 0, s, False
        for e in within:
            et = _epoch(e["ts"])
            if prev_await:
                waited += et - prev                     # marker → resume = operator wait
            prev, prev_await = et, (e.get("type") == "await")
        out.append((label, en - s - waited, waited))
    return out


def cmd_timing(a):
    """Per-phase durations for a work item, derived from ledger timestamps (see
    _phase_durations). Time spent **waiting for the operator** is kept out of the active
    numbers and listed separately: the driver logs an `await` marker when it stops at an
    operator checkpoint, and the gap from that marker to the next recorded event is the
    wait. Prints a `PHASE — <active>` line each, then a one-line `summary:` the PR
    checklist can read."""
    entries = [e for e in _read() if e.get("item") == a.item]
    if not entries:
        print(f"{a.item}: no ledger entries yet")
        return
    phases = _phase_durations(entries)
    if not phases:
        print(f"{a.item}: no completed phases yet")
        return
    report, summary, total_wait = [], [], 0
    for label, active, waited in phases:
        report.append(f"{label} — {_fmt_dur(active)}")
        if waited:
            report.append(f"    waiting   {_fmt_dur(waited)}  (operator)")
        summary.append(f"{label} {_fmt_dur(active)}")
        total_wait += waited
    print(f"{a.item} — phase timing (active work; operator wait listed separately)")
    print("\n".join(report))
    line = "summary: " + "  ·  ".join(summary)
    if total_wait:
        line += f"   |   operator wait: {_fmt_dur(total_wait)}"
    print(line)


def _defer_debt(entries: list[dict], item: str) -> list[str]:
    """Deferred findings of `item` with no follow-up issue reference (#N) in their own
    message or in any later note that names them. A defer without a tracked follow-up
    is scope creep's quiet exit — deferred work must land somewhere visible."""
    ids = {e["id"] for e in entries if e.get("type") == "finding" and e.get("item") == item}
    debt = []
    for e in entries:
        if e.get("type") != "defer" or e.get("ref") not in ids:
            continue
        if re.search(r"#\d+", e.get("msg", "")):
            continue
        # Exact-id match, not substring: ids share prefixes (ISSUE-7-F3 is a prefix of
        # ISSUE-7-F30), so the ref must not be preceded or followed by id characters.
        ref_re = re.compile(r"(?<![A-Za-z0-9])" + re.escape(e["ref"]) + r"(?!\d)")
        linked = any(n.get("type") == "note" and n.get("item") == item
                     and ref_re.search(n.get("msg", "")) and re.search(r"#\d+", n.get("msg", ""))
                     for n in entries)
        if not linked:
            debt.append(e["ref"])
    return debt


def cmd_metrics(a):
    """Outcome & cost scorecard, derived entirely from the ledger. One item with
    --item, every opened item without it.

    Definitions (deliberately simple — every number is recomputable by hand):
      resolved    a fix is on record (proof rigor is the gate's job, not this report's)
      rejected    the arbiter ruled the rebuttal the winner
      deferred    parked as follow-up work (counted separately from resolved)
      escapes     findings filed --phase post-merge: defects that shipped — THE outcome
                  number the pipeline exists to drive down
      precision   of the adversary's adjudicated findings, the share that held up:
                  (resolved + deferred) / (resolved + deferred + rejected)
      debt        deferred findings with no follow-up issue (#N) on the record

    This is the measurement loop: before buying more pipeline (extra reviewers, more
    models, deeper rounds), check whether escapes and precision say it's needed."""
    entries = _read()
    # Key on any item-bearing entry, not just `open` — historic items sometimes lack one.
    items = [a.item] if a.item else sorted({e["item"] for e in entries if e.get("item")})
    if not items:
        print("no work items on record")
        return
    # fix/test/verdict/rebut/defer entries carry only a ref — map them back to their
    # item through the finding they reference so role activity counts them.
    fid_item = {e["id"]: e["item"] for e in entries
                if e.get("type") == "finding" and e.get("id")}
    totals = {"findings": 0, "resolved": 0, "rejected": 0, "deferred": 0,
              "escapes": 0, "open": 0, "debt": 0}
    for item in items:
        it_entries = [e for e in entries
                      if e.get("item") == item
                      or fid_item.get(e.get("ref", "")) == item
                      or e.get("ref") == item]
        findings = _resolve(entries, item)
        sev = {s: 0 for s in SEVERITIES}
        resolved = rejected = deferred = escapes = still_open = 0
        adv_held = adv_rejected = 0
        for f in findings.values():
            sev[f["sev"]] = sev.get(f["sev"], 0) + 1
            if f.get("phase") == "post-merge":
                escapes += 1
                continue
            if f["ruling"] == "rejected":
                rejected += 1
                adv_rejected += f.get("by") == "adversary"
            elif f["deferred"]:
                deferred += 1
                adv_held += f.get("by") == "adversary"
            elif f["fixed"]:
                resolved += 1
                adv_held += f.get("by") == "adversary"
            else:
                still_open += 1
        rounds = sum(1 for e in it_entries if e.get("type") == "round")
        size = next((e.get("size") for e in it_entries if e.get("type") == "open"), None)
        debt = _defer_debt(entries, item)
        roles: dict[str, int] = {}
        for e in it_entries:
            by = e.get("by")
            if by:
                roles[by] = roles.get(by, 0) + 1

        head = f"{item}" + (f" [{size}]" if size else "")
        sev_s = " / ".join(f"{s} {n}" for s, n in sev.items() if n)
        print(f"{head} — findings {len(findings)}" + (f" ({sev_s})" if sev_s else "")
              + f" · rounds {rounds} · escapes {escapes}")
        if findings:
            debt_s = f" ({len(debt)} without follow-up issue)" if debt else ""
            print(f"  outcomes: {resolved} resolved · {rejected} rejected · "
                  f"{deferred} deferred{debt_s} · {still_open} open")
        if adv_held + adv_rejected:
            pct = round(100 * adv_held / (adv_held + adv_rejected))
            print(f"  adversary precision: {adv_held}/{adv_held + adv_rejected} ({pct}%)")
        # Spec economy: surface the most recent recorded ratio note (SDLC/scripts/spec-ratio.py
        # computes it; the driver records it at merge). Advisory context, never a gate.
        econ = [e.get("msg", "") for e in it_entries
                if e.get("type") == "note" and str(e.get("msg", "")).lower().startswith("spec economy")]
        if econ:
            print(f"  {econ[-1]}")
        if roles:
            print("  activity (ledger entries by role): "
                  + " · ".join(f"{r} {n}" for r, n in sorted(roles.items(), key=lambda x: -x[1])))
        phases = _phase_durations(it_entries)
        if phases:
            parts = [f"{lbl} {_fmt_dur(act)}" for lbl, act, _ in phases]
            wait = sum(w for _, _, w in phases)
            print("  phases: " + " · ".join(parts) + (f" · wait {_fmt_dur(wait)}" if wait else ""))
        for k, v in (("findings", len(findings)), ("resolved", resolved), ("rejected", rejected),
                     ("deferred", deferred), ("escapes", escapes), ("open", still_open),
                     ("debt", len(debt))):
            totals[k] += v
    if len(items) > 1:
        print(f"\nTOTALS — items {len(items)} · findings {totals['findings']} · "
              f"resolved {totals['resolved']} · rejected {totals['rejected']} · "
              f"deferred {totals['deferred']} ({totals['debt']} without follow-up issue) · "
              f"escapes {totals['escapes']} · open {totals['open']}")


def main():
    p = argparse.ArgumentParser(description="Adversarial agentic SDLC controls")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("open"); s.add_argument("--item", required=True); s.add_argument("--title", required=True); s.add_argument("--size", choices=SIZES, default="standard", help="drives the driver's path: trivial=fast path, standard=full cycle, epic=must be split first"); s.set_defaults(fn=cmd_open)
    s = sub.add_parser("finding"); s.add_argument("--item", required=True); s.add_argument("--sev", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True); s.add_argument("--phase", choices=("spec", "post-merge"), default=None, help="'spec': resolved by a spec revision alone (no proving test). 'post-merge': an escape — outcome data for metrics, fixed via a new item (only after the merge gate has opened)"); s.add_argument("--force", action="store_true", help="record a post-merge finding before the merge gate has opened (deliberate operator override)"); s.set_defaults(fn=cmd_finding)
    s = sub.add_parser("rebut"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True); s.set_defaults(fn=cmd_rebut)
    s = sub.add_parser("defer"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True, help="where the follow-up lives (e.g. 'spun out as issue #12')"); s.set_defaults(fn=cmd_defer)
    s = sub.add_parser("fix"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True); s.set_defaults(fn=cmd_fix)
    s = sub.add_parser("test"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True); s.add_argument("--test", dest="tests", action="append", default=[], help="proving test as <file[::test name]>; repeatable, at least one required"); s.add_argument("--pre-sha", dest="pre_sha", default="", help="commit the test was run against and FAILED (pre-fix)"); s.add_argument("--post-sha", dest="post_sha", default="", help="commit the test was run against and PASSED (post-fix)"); s.set_defaults(fn=cmd_test)
    s = sub.add_parser("attest", help="verifier disposition: the fix changed no product behavior (a test oracle, a doc, a comment), so a proving test is structurally void; resolves the finding like a spec revision"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--file", dest="files", action="append", default=[], help="a file the fix touched; repeatable, at least one required — CI confirms each exists"); s.add_argument("--kind", choices=("comment",), default=None, help="'comment': assert a non-behavioral comment/docstring change INSIDE product code (required to name a shipped file; flagged for arbiter/human review)"); s.add_argument("--msg", required=True); s.set_defaults(fn=cmd_attest)
    s = sub.add_parser("verdict"); s.add_argument("--ref", required=True); s.add_argument("--by", required=True); s.add_argument("--ruling", required=True); s.add_argument("--msg", default=""); s.add_argument("--force", action="store_true", help="operator override: rule a finding that has no rebuttal (recorded as forced)"); s.set_defaults(fn=cmd_verdict)
    s = sub.add_parser("round"); s.add_argument("--item", required=True); s.add_argument("--by", default="adversary"); s.add_argument("--msg", default=""); s.set_defaults(fn=cmd_round)
    s = sub.add_parser("note"); s.add_argument("--item", required=True); s.add_argument("--by", required=True); s.add_argument("--msg", required=True); s.set_defaults(fn=cmd_note)
    s = sub.add_parser("pause"); s.add_argument("--item", required=True); s.add_argument("--by", default="operator"); s.add_argument("--msg", default="", help="why the cycle is paused"); s.set_defaults(fn=cmd_pause)
    s = sub.add_parser("resume"); s.add_argument("--item", required=True); s.add_argument("--by", default="operator"); s.add_argument("--msg", default=""); s.set_defaults(fn=cmd_resume)
    s = sub.add_parser("abort"); s.add_argument("--item", required=True); s.add_argument("--by", default="operator"); s.add_argument("--msg", default="", help="why the cycle is aborted"); s.set_defaults(fn=cmd_abort)
    s = sub.add_parser("gate"); s.add_argument("--item", required=True); s.add_argument("--phase", required=True, choices=PHASES); s.add_argument("--exit-code", dest="exit_code", action="store_true", help="exit 1 if the gate is blocked (for CI status checks)"); s.set_defaults(fn=cmd_gate)
    s = sub.add_parser("status"); s.add_argument("--item", required=True); s.set_defaults(fn=cmd_status)
    s = sub.add_parser("state"); s.add_argument("--item", default="", help="omit for a one-line-per-item overview"); s.set_defaults(fn=cmd_state)
    s = sub.add_parser("timing"); s.add_argument("--item", required=True); s.set_defaults(fn=cmd_timing)
    s = sub.add_parser("metrics"); s.add_argument("--item", default="", help="one item; omit for a scorecard of every opened item"); s.set_defaults(fn=cmd_metrics)
    s = sub.add_parser("await"); s.add_argument("--item", required=True); s.add_argument("--for", dest="reason", default="", help="what is being awaited (e.g. 'spec continue')"); s.set_defaults(fn=cmd_await)
    s = sub.add_parser("log"); s.add_argument("--item", default=""); s.set_defaults(fn=cmd_log)
    s = sub.add_parser("doctor"); s.add_argument("--exit-code", dest="exit_code", action="store_true", help="exit 1 if the ledger has integrity problems (for CI)"); s.set_defaults(fn=cmd_doctor)
    s = sub.add_parser("verify-gate", help="CI: run every ledger-semantic check (integrity, append-only, tests-exist, merge gate) in one call; exit 1 on any failure"); s.add_argument("--item", required=True); s.add_argument("--base", default="", help="PR base sha — enables the append-only check (omit on non-PR runs)"); s.set_defaults(fn=cmd_verify_gate)
    s = sub.add_parser("version"); s.set_defaults(fn=cmd_version)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
