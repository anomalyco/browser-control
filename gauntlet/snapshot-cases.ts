import { Effect } from "effect"
import type { GauntletCase } from "./cases.ts"
import { assert, withSession } from "./harness.ts"

export const snapshotCases: readonly GauntletCase[] = [
  {
    name: "snapshot-native-controls",
    summary: "Native control snapshot refs intersect the correct Playwright roles and retain text-value privacy",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/snapshot-controls.html`,
    budgetMs: 30_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const result = yield* ctx.execute({
        sessionId,
        code: `
          await page.goto(${JSON.stringify(`${ctx.fixtures.primaryOrigin}/snapshot-controls.html`)});
          const text = await snapshot();
          if (text.includes('PRIVATE_TEXT_SENTINEL')) throw new Error('snapshot exposed a text-control value');
          const controls = [
            ['multiple', 'listbox', 'Multiple choices'],
            ['sized', 'listbox', 'Sized choices'],
            ['single', 'combobox', 'Single choice'],
            ['volume', 'slider', 'Volume'],
            ['attachment', 'button', 'Attachment'],
            ['city', 'combobox', 'City'],
            ['find-city', 'combobox', 'Find city'],
            ['plain-search', 'searchbox', 'Plain search'],
            ['missing-list', 'textbox', 'Missing list'],
          ];
          for (const [id, role, name] of controls) {
            const line = text.split('\\n').find(line => line.includes('- ' + role + ' "' + name + '"'));
            const refId = line?.match(/ref=(e\\d+)/)?.[1];
            if (!refId) throw new Error('missing native role/ref for ' + id + ': ' + text);
            const locator = ref(refId);
            if (await locator.count() !== 1 || await locator.getAttribute('id') !== id)
              throw new Error('native ref did not resolve exactly to ' + id);
          }
          return controls.length;
        `,
      })
      assert(result.ok && result.value === 9, "native snapshot refs must resolve to all nine controls", result)
    })),
  },
  {
    name: "snapshot-document-baseline",
    summary: "Reload and document navigation invalidate explicit diffs, restart automatic deltas, and never revive old refs",
    fixtureUrl: ({ primaryOrigin }) => `${primaryOrigin}/snapshot-controls.html`,
    budgetMs: 30_000,
    run: (_page, ctx) => withSession(ctx, Effect.fnUntraced(function* (sessionId) {
      const url = `${ctx.fixtures.primaryOrigin}/snapshot-controls.html`
      const initial = yield* ctx.execute({
        sessionId,
        code: `
          await page.goto(${JSON.stringify(url)});
          state.before = await snapshot({ delta: true });
          state.oldRefs = [...state.before.matchAll(/ref=(e\\d+)/g)].map(match => match[1]);
          return state.oldRefs.length;
        `,
      })
      assert(initial.ok && initial.value === 9, "initial document should expose nine native refs", initial)
      for (const navigation of ["await page.reload()", `await page.goto(${JSON.stringify(`${url}?replacement=1`)})`]) {
        const result = yield* ctx.execute({
          sessionId,
          code: `
            ${navigation};
            let diffError = '';
            try { await snapshot({ diff: true }); } catch (error) { diffError = error.message; }
            if (!diffError.includes('requires a previous snapshot() baseline'))
              throw new Error('explicit diff accepted a previous document baseline: ' + diffError);
            const text = await snapshot({ delta: true });
            if (!text.includes('- heading "Native controls"') || text.includes('unchanged'))
              throw new Error('automatic delta did not return the replacement document: ' + text);
            for (const oldRef of state.oldRefs) {
              let rejected = false;
              try { ref(oldRef); } catch (error) { rejected = /Unknown snapshot ref|Snapshot refs are stale/.test(error.message); }
              if (!rejected) throw new Error('old document ref revived: ' + oldRef);
            }
            const nextRefs = [...text.matchAll(/ref=(e\\d+)/g)].map(match => match[1]);
            if (nextRefs.length !== 9) throw new Error('replacement document missing refs');
            for (const id of nextRefs) if (await ref(id).count() !== 1) throw new Error('new ref does not resolve: ' + id);
            state.oldRefs.push(...nextRefs);
            const delta = await snapshot({ delta: true });
            if (!delta.startsWith('0 additions, 0 removals,')) throw new Error('new document baseline not retained: ' + delta);
            return true;
          `,
        })
        assert(result.ok && result.value === true, "navigation must retire the baseline and old refs across execute calls", result)
      }
    })),
  },
]
