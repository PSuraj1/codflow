import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Test environment setup.
 *
 * `cleanup` unmounts anything a test rendered. Without it React trees
 * accumulate in the shared jsdom document and queries like `getByLabelText`
 * start finding the *previous* test's elements — which produces failures that
 * depend on file order and disappear when a test is run alone.
 */
afterEach(() => {
  cleanup();
});

/**
 * `matchMedia` is not implemented in jsdom, and Polaris calls it while
 * resolving its responsive breakpoints. Without a stub every render throws
 * before a single assertion runs.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

/** Polaris scroll-lock and some overlays reach for these. */
Object.defineProperty(window, 'scrollTo', { writable: true, value: () => undefined });

/**
 * `ResizeObserver` is not implemented in jsdom either, and Polaris's `Popover`
 * — which `Tabs` mounts to hold its overflow menu — constructs one on mount.
 * Without this, rendering any tabbed screen throws before an assertion runs,
 * and the message names Popover rather than the tabs the test is about.
 *
 * A no-op is the right stub: nothing under test depends on a resize actually
 * firing, and a stub that invoked the callback would report a zero-sized
 * element on every observation, which is less true than never reporting at all.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: ResizeObserverStub,
});

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
