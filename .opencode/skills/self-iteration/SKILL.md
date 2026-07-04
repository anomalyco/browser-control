---
name: self-iteration
description: Dogfood a project-owned tool in a realistic user flow and evaluate the agent experience. Use when the user asks to dogfood or self-iterate, or when testing or evaluating a tool built by this project.
---

# Self-Iteration

Run a **field test**: use the tool to complete a real task for the user while
observing the agent experience. The task, not the evaluation, remains the
primary goal.

## Workflow

1. Agree on a realistic task and its safety boundary. If the user has no task,
suggest one that exercises the tool's main workflow without destructive or
irreversible actions.

Completion criterion: the user and agent share a concrete task, expected
outcome, and boundary for actions requiring confirmation.

2. Perform the task through the public interface an agent is expected to use.
Prefer the shortest natural path; do not manufacture edge cases or switch to
internal interfaces merely to make progress.

While working, note only observed evidence:

- extra round trips or context needed to choose the next action
- slow operations or avoidable waiting
- confusing names, shapes, defaults, errors, or documentation
- failures, missing capabilities, and recovery quality
- behavior that made the flow unusually direct or token-efficient

Completion criterion: the user's task is complete or a specific blocker has
been identified, and each finding is tied to an observed step in the flow.

3. Give the user the task result first. Then report the field-test verdict:

- bugs, with reproduction evidence and impact
- concrete improvement suggestions, separated from bugs
- strengths worth preserving
- an explicit "went well" verdict when no change is justified

Do not modify the tool in response to findings during the field test. Surface
findings first so the user can choose what to implement.

Completion criterion: the user receives both the useful task outcome and a
concise, evidence-based verdict on the tool experience.
