// Node loader hook used by make-schema23-fixture.ts: the test helpers import `expect` from 'vitest', which cannot be imported outside the
// vitest runner. This maps 'vitest' to a tiny stub (the generator never calls expect()).
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'vitest') return { url: 'data:text/javascript,export const expect = () => { throw new Error("expect is not available outside vitest"); };', shortCircuit: true };
  return next(specifier, context);
}
`));
