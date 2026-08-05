/**
 * @codflow/shared — the contract surface shared by the API, the admin UI, and
 * the storefront extensions.
 *
 * Anything exported here is consumed by at least two of those three. Types that
 * belong to a single app stay in that app. Zod schemas live alongside the types
 * they validate so a single import gives you both the runtime validator and the
 * inferred TypeScript type.
 *
 * Request/response contracts arrive with the phase that introduces the
 * endpoint; `./contracts` is the barrel they land in.
 */

export * from './constants.js';
export * from './enums.js';
export * from './countries.js';
export * from './contracts/index.js';
export * from './validation/index.js';
