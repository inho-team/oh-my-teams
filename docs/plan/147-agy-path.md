# Issue #147 Agy Official-Path Probe Evidence

## Current Dispatch Settlement Evidence (Orca 1.4.220)

**Observations:**
- **Model Identity**: Gemini 3.1 Pro (High)
- **Terminal Identity**: `term_652dcc42-a155-4070-8072-8c782f2c883c`
- **Orca Runtime**: 1.4.220
- **Worktree**: `/Users/jinsungkim/orca/workspaces/oh-my-teams/issue-147-agy-probe`
- **Readiness**: `true` (The agent is actively executing tasks and responding in the terminal)
- **Dispatch Identity**:
  - `dispatchId`: `ctx_7117f2ebd635`
  - `runId`: `run_236793a9ef83`
  - `taskId`: `task_28b11709d607`

**Inferences:**
- **Observed State**: The Dispatch was successfully created and attached. The agy role terminal received the official kickoff and is executing the task. (Ready=true alone is not the proof; the presence of actual injected environment variables and task information like `ctx_7117f2ebd635` proves the Dispatch).
- **Likely Responsibility Boundary**: Given that Orca 1.4.220 successfully establishes the Dispatch and the terminal is active, the prior idle check failure (Orca 1.4.217) was likely due to the terminal failing to report `tui-idle` in time, rather than a fundamental inability to run the agy role. The responsibility boundary lies in the Orca `worker-start` idle check conditions.

## Prior Timeout Evidence (idle-failure-observation.json)

**Observations:**
- **Observation Date**: 2026-09-30T12:50:00Z
- **Runtime**: Orca 1.4.217
- **Agy Version On Screen**: 1.2.14
- **Model On Screen**: Gemini 3.1 Pro (High)
- **Terminal**: `term_92ea125f-d463-4292-a45e-24d6253d685f`
- **Idle Check Failure**: `exitCode: 1`, `errorCode: "timeout"`
- **Message**: "Terminal term_92ea125f-d463-4292-a45e-24d6253d685f did not report tui-idle within 20000ms, which Orca worker-start waits for before handing over a task; no Dispatch was created. Do not repeat the start (references/orca-runtime.md)"
- **Dispatch Created**: `false`
