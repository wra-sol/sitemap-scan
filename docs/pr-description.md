## Summary

- unify backup execution behind a canonical runtime path for both scheduled and manual runs
- introduce a first-class operator console with run visibility, site management workflows, and embedded explorer access
- improve storage, change detection, notification behavior, and test coverage to make the Worker more production-ready

## What Changed

### Runtime And Execution

- added shared runtime helpers for:
  - compressed backup content storage and decoding
  - run recording and latest run state
  - site-level data cleanup
  - site backup execution orchestration
- updated `src/index.ts` so scheduled and manual backups use the same execution flow
- added run-oriented APIs for recent activity and site overview data
- made site deletion clean up related runtime data instead of only deleting config

### Operator Experience

- added a new operator console at `/app`
- included:
  - site overview cards
  - recent run history
  - JSON site editor
  - backup trigger and reset actions
  - Slack test action
  - embedded backup and diff explorer access
- fixed secured deployment auth flow so viewer surfaces can work with the admin token

### Storage And Diffing

- centralized backup content encoding/decoding
- updated backup storage to persist encoded content metadata
- updated backup and diff read paths to decode stored content consistently
- enforced `minChangeSize` using a more meaningful normalized content delta
- kept diff generation compatible with encoded backup payloads

### Notifications

- added richer Slack delivery result handling
- added short-window duplicate alert throttling
- added digest-style behavior for larger change sets
- kept change and error notifications integrated with the new run-record model

### Reliability And Tests

- added `src/index.spec.ts` integration coverage for:
  - auth protection
  - operator console availability
  - site creation and retrieval
  - manual backup triggering
  - run history and overview endpoints
  - backup source/preview decoding
  - comprehensive site cleanup
- expanded notifier coverage for duplicate alert throttling
- updated diff generator coverage for active storage behavior
- kept existing fetcher coverage passing after the runtime/storage changes

### Scale Planning

- added `docs/platform-evolution.md` with a staged migration path for:
  - `R2` backup payload storage
  - `D1` run history and analytics
  - queue-backed orchestration
  - future multi-workspace support

## Files Of Note

- `src/index.ts`
- `src/http/operator-console.ts`
- `src/runtime/content-storage.ts`
- `src/runtime/run-store.ts`
- `src/runtime/site-data.ts`
- `src/runtime/site-execution.ts`
- `src/backup/fetcher.ts`
- `src/slack/notifier.ts`
- `src/index.spec.ts`
- `docs/platform-evolution.md`

## Test Plan

- [x] `npm run build`
- [x] `npx vitest run src/index.spec.ts src/slack/notifier.spec.ts src/diff/comparer.spec.ts src/diff/generator.spec.ts src/backup/fetcher.spec.ts`

## Risks / Follow-Ups

- the operator console currently uses JSON editing for site configuration rather than a structured form UI
- the new scale path is documented, but `R2`, `D1`, and queue-backed orchestration are not yet enabled in production code
- README alignment should be reviewed so documentation exactly matches the new operator and runtime flows
