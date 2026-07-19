---
name: threat-model
description: Structured STRIDE threat-modeling pass over a change or component, producing prioritized findings for the adversary to file. Use when red-teaming security, threat modeling a feature, or auditing trust boundaries and attack surface.
---

# Threat model (STRIDE)

A disciplined security pass so the `adversary` attacks the whole surface, not just the
obvious spot. Produces a ranked list of candidate findings.

**When it is mandatory, not optional:** the first attack round of any item whose diff
touches a trust boundary — `server/`, `worker/`, `migrations/`, auth, input parsing,
anything network-facing. (CI's semgrep/audit jobs are the mechanical floor below this
pass; their hits are also candidate findings — reproduce and file them, don't just read
the log.) Run this pass **against the artifact, not the spec**: read the code and the
running behavior first, so you don't inherit the spec's assumptions about what's safe.

## 1. Map the surface
- **Entry points:** every input — request params, headers, files, env, queue messages,
  CLI args, IPC.
- **Trust boundaries:** where data crosses from less-trusted to more-trusted (network →
  app, user → admin, tenant → tenant).
- **Assets:** secrets, PII, money, auth tokens, the ability to execute or write.

## 2. Apply STRIDE at each boundary

| Threat | Ask | Common defects |
|--------|-----|----------------|
| **S**poofing | Can identity be faked? | weak/missing authn, token replay, predictable IDs |
| **T**ampering | Can data be altered in flight or at rest? | missing integrity checks, mass-assignment, path traversal |
| **R**epudiation | Can an actor deny an action? | no/forgeable audit log |
| **I**nfo disclosure | Can secrets/data leak? | verbose errors, secrets in logs, IDOR, SSRF |
| **D**enial of service | Can it be exhausted? | unbounded input, no rate limit, ReDoS, amplification |
| **E**levation of privilege | Can authz be bypassed? | missing checks, confused deputy, injection → RCE |

## 3. Probe the classics
Injection (SQL/shell/path/template), broken authz & IDOR, secrets in code/logs,
unsafe deserialization, SSRF, weak crypto / hardcoded keys, TOCTOU races, missing
validation at trust boundaries, unsafe defaults / fail-open.

## 4. Rank and hand off
Score each candidate by **impact × reachability**. For each real one, file via the
adversary's channel:
```
python SDLC/sdlc.py finding --item <ID> --sev <blocker|major|minor|nit> \
  --by adversary --msg "<threat: exact location + trigger input + impact>"
```
Security defects that work on a normal/reachable path are **blockers**. Don't file
theoretical issues you can't show a path to — note them as residual risk instead.
