/**
 * The shared validation engine.
 *
 * Imported by the admin builder (to preview rules), the storefront renderer (to
 * give immediate feedback) and the API (to decide whether an order is created).
 * One implementation, three consumers — which is the only way client-side and
 * server-side validation can be guaranteed to agree about what a merchant's
 * rules mean.
 */

export * from './conditions.js';
export * from './fields.js';
export * from './form.js';
