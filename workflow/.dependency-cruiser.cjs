/**
 * The dependency rule from DESIGN.md §11.7, enforced.
 *   domain   imports nothing
 *   core     imports domain + ports
 *   adapters import ports + their vendor SDK
 *   nothing imports adapters except container.ts
 */
const VENDOR = '^(?!(src|node:))';

module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'domain/ must not import anything outside domain/.',
      from: { path: '^src/domain' },
      to: { pathNot: '^src/domain', dependencyTypesNot: ['core'] },
    },
    {
      name: 'core-never-touches-vendors',
      severity: 'error',
      comment: 'core/ may only import domain/ and ports/. No vendor SDKs.',
      from: { path: '^src/core' },
      to: { pathNot: '^src/(domain|ports|core)', dependencyTypesNot: ['core'] },
    },
    {
      name: 'only-container-builds-adapters',
      severity: 'error',
      comment: 'adapters/ is constructed in container.ts and nowhere else.',
      from: { pathNot: '^src/(container\\.ts|adapters)' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'ports-are-interfaces-only',
      severity: 'error',
      comment: 'ports/ must not import core/ or adapters/.',
      from: { path: '^src/ports' },
      to: { path: '^src/(core|adapters)' },
    },
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn', from: { orphan: true, pathNot: '\\.d\\.ts$' }, to: {} },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
