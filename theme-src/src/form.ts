/**
 * CODkar — COD form renderer.
 *
 * Bundled by `build.mjs` into `assets/codflow-form.js`, and loaded lazily by
 * `codflow.js` the first time a shopper opens the dialog. Most page views never
 * open it, so shipping this in the always-on bundle would make every product
 * page pay for a form nobody asked for.
 *
 * The bundling exists for one reason: this file imports the **real** validation
 * engine from `@codflow/shared` — the same functions the API runs on
 * submission. Hand-writing a second copy in vanilla JS is the obvious
 * alternative and the wrong one: the two would diverge, and the symptom would
 * be a shopper who passes client validation and is then rejected by the server
 * with no way to tell what is wrong.
 */

import {
  COUNTRIES,
  HONEYPOT_FIELD_NAME,
  POSTAL_FORMATS,
  coerceValue,
  resolveVisibility,
  isValidPostalFormat,
  supportsPostalLookup,
  validateField,
  validateForm,
  type FieldValue,
  type FormDefinition,
  type FormFieldDefinition,
  type FormValues,
  type PostalLookupResult,
  type StorefrontBranding,
  type StorefrontConfig,
  type StorefrontFormResponse,
} from '@codflow/shared';

const PROXY_BASE = '/apps/codflow';

/** What the proxy answers with, before the envelope is unwrapped. */
interface ProxyResponse<T> {
  readonly status: number;
  readonly body: T;
}

/**
 * A request that survives the storefront it runs in.
 *
 * `XMLHttpRequest` rather than `fetch`, and the reason is measured rather than
 * stylistic: Shopify's Web Pixels Manager replaces `window.fetch` on every
 * storefront, and that wrapper intermittently never settles for app-proxy
 * requests. The same fault silently stopped the COD button from rendering; here
 * it is worse, because the two calls it would hang are *loading the form* and
 * *submitting the order* — the second being the moment a shopper has already
 * decided to buy.
 *
 * The timeout is the load-bearing half. A promise that never settles leaves the
 * submit button disabled and the shopper staring at "Placing your order…"
 * forever, with no error and no way back. Better to fail in twenty seconds and
 * let them retry.
 *
 * `withCredentials` is left at its default of false: the proxy endpoints are
 * deliberately credential-free, and attaching cookies would tie a cacheable
 * public response to an individual shopper.
 */
function request<T>(
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; timeoutMs?: number } = {},
): Promise<ProxyResponse<T>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open(method, url, true);
    xhr.setRequestHeader('Accept', 'application/json');
    if (options.body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.timeout = options.timeoutMs ?? 20_000;

    xhr.onload = (): void => {
      try {
        // Resolve on any status: the API reports validation failures as 4xx
        // with a body the caller needs in order to bind field errors.
        resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) as T });
      } catch {
        reject(new Error('The server returned a response that was not JSON'));
      }
    };

    xhr.onerror = (): void => reject(new Error('Network error'));
    xhr.ontimeout = (): void => reject(new Error(`Request timed out after ${xhr.timeout}ms`));

    xhr.send(options.body === undefined ? null : JSON.stringify(options.body));
  });
}

export interface PageContext {
  shop: {
    domain: string;
    currency: string;
    moneyFormat: string;
    locale: string;
    rootUrl: string;
    /** Drives which country's postal rules apply. Absent on older embeds. */
    countryCode?: string;
  };
  page: { type: string; template: string; designMode: boolean };
  product: {
    id: string | number;
    variantId: string | number;
    available: boolean;
    handle: string;
    title: string;
    price: number;
    featuredImage: string;
  };
  cart: { itemCount: number; totalPrice: number };
  customer: {
    isLoggedIn: boolean;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
  strings: Record<string, string>;
}

interface RenderOptions {
  root: HTMLElement;
  context: PageContext;
  config: StorefrontConfig;
}

let cachedForm: StorefrontFormResponse | null = null;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Renders an amount using the shop's own money format.
 *
 * Shopify's `money_format` is a Liquid template such as `₹{{amount}}` or
 * `${{amount_no_decimals}}`. Using `Intl.NumberFormat` instead would produce a
 * correctly-formatted number in the *wrong* presentation — the merchant has
 * already decided how prices look on their storefront, and a COD form that
 * disagrees looks like it belongs to a different shop.
 */
export function formatMoney(amount: number, context: PageContext): string {
  const format = context.shop.moneyFormat || '{{amount}}';

  const withDecimals = amount.toFixed(2);
  const noDecimals = Math.round(amount).toString();

  const grouped = (value: string): string => {
    const [whole, fraction] = value.split('.');
    const withSeparators = (whole ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fraction ? `${withSeparators}.${fraction}` : withSeparators;
  };

  return format
    .replace(/\{\{\s*amount\s*\}\}/g, grouped(withDecimals))
    .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, grouped(noDecimals))
    .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/g, grouped(withDecimals).replace('.', ','))
    .replace(/\{\{\s*amount_no_decimals_with_comma_separator\s*\}\}/g, grouped(noDecimals));
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }

  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/**
 * Announces a storefront event.
 *
 * Dispatched on `document`, where the merchant's own theme code can observe it,
 * and also pushed onto the queue the pixel bundle drains. The queue is what
 * keeps a conversion reportable when the shopper submits before that bundle has
 * finished loading — the one case where a lost event costs the merchant money.
 * The bundle dedupes by event id, so arriving twice reports once.
 */
function emit(name: string, detail: Record<string, unknown>): void {
  // Typed as a sink rather than an array: once the pixel bundle has started it
  // replaces the array with a shim, because by then the `document` event below
  // is enough on its own and a growing array would never be drained again.
  const host = window as unknown as {
    CodFlowPixelQueue?: { push(entry: { name: string; detail: unknown }): unknown };
  };

  host.CodFlowPixelQueue = host.CodFlowPixelQueue ?? [];
  host.CodFlowPixelQueue.push({ name, detail });

  document.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Stable DOM id for a field's input, so labels and errors can reference it. */
function inputId(key: string): string {
  return `codflow-field-${key}`;
}

function errorId(key: string): string {
  return `codflow-error-${key}`;
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

/**
 * Builds the control for one field.
 *
 * Every branch sets `name`, `id` and the ARIA wiring, because the wrapper below
 * relies on all three. A control without `aria-describedby` pointing at its
 * error element is one a screen reader user cannot debug — they hear "invalid"
 * with no reason.
 */
function buildControl(field: FormFieldDefinition, initial: FieldValue): HTMLElement {
  const id = inputId(field.key);
  const shared: Record<string, string> = {
    id,
    name: field.key,
    class: 'codflow-input',
    'aria-describedby': errorId(field.key),
  };

  if (field.validation.required) shared['aria-required'] = 'true';
  if (field.placeholder) shared.placeholder = field.placeholder;

  switch (field.type) {
    case 'TEXTAREA': {
      const node = el('textarea', { ...shared, rows: '3' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'SELECT':
    case 'COUNTRY':
    case 'STATE': {
      const node = el('select', shared);
      node.appendChild(
        el('option', { value: '' }, [field.placeholder ?? `Select ${field.label.toLowerCase()}`]),
      );

      /*
       * A country field the merchant never populated would otherwise render as
       * a required select containing only its own placeholder — unsatisfiable,
       * on the checkout path. Expecting every merchant to type two hundred
       * options into the form builder was never realistic, so the shared list
       * stands in. A merchant who *has* set options keeps theirs, which is how
       * "we only ship to three countries" continues to work.
       */
      const options =
        field.type === 'COUNTRY' && field.options.length === 0 ? COUNTRIES : field.options;

      for (const option of options) {
        const optionNode = el('option', { value: option.value }, [option.label]);
        if (String(initial) === option.value) optionNode.setAttribute('selected', 'selected');
        node.appendChild(optionNode);
      }
      return node;
    }

    case 'MULTISELECT': {
      const node = el('select', { ...shared, multiple: 'multiple' });
      const selected = Array.isArray(initial) ? initial.map(String) : [];
      for (const option of field.options) {
        const optionNode = el('option', { value: option.value }, [option.label]);
        if (selected.includes(option.value)) optionNode.setAttribute('selected', 'selected');
        node.appendChild(optionNode);
      }
      return node;
    }

    case 'RADIO': {
      // A radio group is the one control that is not a single element, so it
      // gets a fieldset — which is also what makes the group's label audible to
      // a screen reader rather than just the individual options.
      const group = el('div', { class: 'codflow-radio-group', role: 'radiogroup', id });
      for (const [index, option] of field.options.entries()) {
        const optionId = `${id}-${index}`;
        const input = el('input', {
          type: 'radio',
          id: optionId,
          name: field.key,
          value: option.value,
          class: 'codflow-radio',
        });
        if (String(initial) === option.value) input.setAttribute('checked', 'checked');
        group.appendChild(
          el('label', { class: 'codflow-radio-label', for: optionId }, [input, option.label]),
        );
      }
      return group;
    }

    case 'CHECKBOX':
    case 'CONSENT': {
      const input = el('input', { ...shared, type: 'checkbox', class: 'codflow-checkbox' });
      if (initial === true) input.setAttribute('checked', 'checked');
      return input;
    }

    case 'NUMBER':
    case 'QUANTITY': {
      const node = el('input', { ...shared, type: 'number', inputmode: 'numeric' });
      if (field.validation.minValue != null) node.min = String(field.validation.minValue);
      if (field.validation.maxValue != null) node.max = String(field.validation.maxValue);
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'DATE': {
      const node = el('input', { ...shared, type: 'date' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'EMAIL': {
      // `type=email` gives mobile keyboards the @ key. Browser-native validation
      // is suppressed with `novalidate` on the form so the shared engine is the
      // only thing deciding what is valid.
      const node = el('input', { ...shared, type: 'email', autocomplete: 'email' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'PHONE': {
      const node = el('input', {
        ...shared,
        type: 'tel',
        inputmode: 'tel',
        autocomplete: 'tel',
      });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'POSTAL_CODE': {
      const node = el('input', { ...shared, type: 'text', autocomplete: 'postal-code' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    case 'HIDDEN': {
      const node = el('input', { ...shared, type: 'hidden' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }

    default: {
      const node = el('input', { ...shared, type: 'text' });
      node.value = initial === null || initial === undefined ? '' : String(initial);
      return node;
    }
  }
}

/** Autofill hints for the browser, keyed on the pipeline's system field names. */
const AUTOCOMPLETE: Record<string, string> = {
  firstName: 'given-name',
  lastName: 'family-name',
  address1: 'address-line1',
  address2: 'address-line2',
  city: 'address-level2',
  province: 'address-level1',
  country: 'country-name',
};

/**
 * Puts the merchant's logo above the dialog heading, or takes it away.
 *
 * `logoUrl` was carried by the column, the admin screen, that screen's preview
 * and the storefront config from the start, and nothing ever rendered it — so a
 * merchant uploaded a logo, saw it in the preview, saved, and never saw it on
 * their own store. This is the missing end of that pipe.
 *
 * It goes in the dialog chrome beside the title rather than in the form body,
 * because the body is rebuilt from empty on every render — `renderSuccess`
 * replaces it outright — and a logo that disappeared the moment an order
 * succeeded would be a stranger bug than the one being fixed.
 *
 * Idempotent by necessity, not by taste: `render()` runs again on a locale
 * change and after a failed submit, and appending each time would stack a
 * column of identical logos down the dialog.
 */
export function syncDialogLogo(title: Element, branding: StorefrontBranding): void {
  const existing = title.parentNode?.querySelector('.codflow-dialog__logo') ?? null;

  // A merchant who clears the logo sees it gone on the next render rather than
  // on the next full page load.
  if (!branding.logoUrl) {
    existing?.remove();
    return;
  }

  const image =
    existing instanceof HTMLImageElement
      ? existing
      : el('img', {
          class: 'codflow-dialog__logo',
          // Decorative on purpose: the heading beside it already names the
          // dialog, so alt text here would announce the same thing twice.
          alt: '',
          loading: 'lazy',
          decoding: 'async',
        });

  image.src = branding.logoUrl;

  /**
   * Height as a variable and alignment as a margin, both set inline.
   *
   * Inline rather than a class per alignment because the height is a free
   * number — a stylesheet cannot enumerate 16 through 120. `auto` margins are
   * what centre and right-align a block image; `display: block` in the
   * stylesheet is what makes them work.
   */
  image.style.setProperty('--codflow-logo-height', `${branding.logoHeight}px`);
  image.style.marginInlineStart = branding.logoAlignment === 'left' ? '0' : 'auto';
  image.style.marginInlineEnd = branding.logoAlignment === 'right' ? '0' : 'auto';

  if (!existing) title.parentNode?.insertBefore(image, title);
}

/**
 * Wraps a control with its label, help text and error slot.
 *
 * Presentational field types short-circuit — a HEADING is not a form control
 * and giving it a `<label for>` pointing at nothing is an accessibility error,
 * not merely redundant markup.
 */
export function buildField(field: FormFieldDefinition, initial: FieldValue): HTMLElement {
  if (field.type === 'HEADING') {
    return el('h3', { class: 'codflow-form__heading' }, [field.label]);
  }

  if (field.type === 'PARAGRAPH') {
    return el('p', { class: 'codflow-form__paragraph' }, [field.helpText ?? field.label]);
  }

  if (field.type === 'DIVIDER') {
    return el('hr', { class: 'codflow-form__divider' });
  }

  const control = buildControl(field, initial);

  const autocomplete = AUTOCOMPLETE[field.key];
  if (autocomplete && control instanceof HTMLInputElement) {
    // `autocomplete` is typed as the `AutoFill` union rather than string. The
    // values in the map are all valid tokens, but TypeScript cannot know that
    // from a Record<string, string>.
    control.autocomplete = autocomplete as HTMLInputElement['autocomplete'];
  }

  const wrapper = el('div', {
    class: `codflow-field codflow-field--${field.type.toLowerCase()}`,
    'data-codflow-field': field.key,
    style: `--codflow-col: ${field.columnWidth}`,
  });

  if (field.hidden || field.type === 'HIDDEN') {
    wrapper.setAttribute('hidden', '');
  }

  const isBoolean = field.type === 'CHECKBOX' || field.type === 'CONSENT';

  const label = el('label', { class: 'codflow-label', for: inputId(field.key) }, [
    field.label,
    ...(field.validation.required
      ? [el('span', { class: 'codflow-required', 'aria-hidden': 'true' }, ['*'])]
      : []),
  ]);

  if (isBoolean) {
    // Checkbox before its label, so the control and its text form one tap
    // target rather than two.
    wrapper.appendChild(el('div', { class: 'codflow-checkbox-row' }, [control, label]));
  } else {
    wrapper.appendChild(label);
    wrapper.appendChild(control);
  }

  // PARAGRAPH already returned above, so no type guard is needed here.
  if (field.helpText) {
    wrapper.appendChild(el('p', { class: 'codflow-help' }, [field.helpText]));
  }

  // Always present, even when empty: an element that appears only on error is
  // one `aria-describedby` cannot reference ahead of time, and screen readers
  // announce nothing when it materialises.
  wrapper.appendChild(
    el('p', { class: 'codflow-error', id: errorId(field.key), role: 'alert', hidden: 'hidden' }),
  );

  return wrapper;
}

// ---------------------------------------------------------------------------
// Form controller
// ---------------------------------------------------------------------------

class CodFormController {
  private readonly form: FormDefinition;
  private readonly context: PageContext;
  private readonly config: StorefrontConfig;

  /**
   * Ids of the tick-box add-ons the shopper has accepted.
   *
   * Ids only, and only ids are ever sent: the server re-resolves every price
   * from its own records, so this decides *which* add-ons are charged and never
   * what they cost.
   */
  private readonly selectedBumps = new Set<string>();

  /** Whether the merchant's default ticks have been applied. Applied once. */
  private bumpsSeeded = false;
  private readonly formToken: string;
  private readonly root: HTMLElement;

  private values: FormValues = {};
  private quantity = 1;
  private submitting = false;
  /** Fields the shopper has interacted with. Only these show errors as they type. */
  private touched = new Set<string>();

  /** Debounce handle and sequence guard for the postal lookup. */
  private postalTimer = 0;
  private postalSequence = 0;

  constructor(options: RenderOptions & { response: StorefrontFormResponse }) {
    this.form = options.response.form;
    this.formToken = options.response.formToken;
    this.context = options.context;
    this.config = options.config;
    this.root = options.root;
  }

  /**
   * Seeds values from the signed-in customer and each field's default.
   *
   * Pre-filling from the Shopify account measurably lifts completion, and the
   * values come from Shopify's own record rather than anything the app stored.
   */
  private seedValues(): void {
    const customer = this.context.customer;

    for (const field of this.form.fields) {
      let initial: FieldValue = field.defaultValue ?? null;

      if (customer.isLoggedIn) {
        if (field.key === 'firstName' && customer.firstName) initial = customer.firstName;
        if (field.key === 'lastName' && customer.lastName) initial = customer.lastName;
        if (field.key === 'email' && customer.email) initial = customer.email;
        if (field.key === 'phone' && customer.phone) initial = customer.phone;
      }

      this.values[field.key] = initial;
    }
  }

  render(): void {
    this.seedValues();

    const body = this.root.querySelector('[data-codflow-body]');
    const title = this.root.querySelector('.codflow-dialog__title');

    if (!body || !title) return;

    syncDialogLogo(title, this.config.branding);

    title.textContent = this.form.headingText;
    body.innerHTML = '';

    const formElement = el('form', {
      class: `codflow-form codflow-form--${this.form.layout}`,
      novalidate: 'novalidate',
      'data-codflow-form': this.form.id,
    });

    if (this.form.subheadingText) {
      formElement.appendChild(
        el('p', { class: 'codflow-form__subheading' }, [this.form.subheadingText]),
      );
    }

    if (this.form.showOrderSummary) {
      formElement.appendChild(this.buildSummary());
    }

    if (this.config.bumps.length > 0) {
      formElement.appendChild(this.buildBumps());
    }

    const grid = el('div', { class: 'codflow-grid' });

    for (const field of this.form.fields) {
      if (!field.enabled) continue;
      grid.appendChild(buildField(field, this.values[field.key] ?? null));
    }

    formElement.appendChild(grid);

    // Honeypot. Hidden from humans with CSS rather than `hidden`, because a
    // script filling every input skips `[hidden]` but not an off-screen field.
    formElement.appendChild(
      el('div', { class: 'codflow-hp', 'aria-hidden': 'true' }, [
        el('input', {
          type: 'text',
          name: HONEYPOT_FIELD_NAME,
          tabindex: '-1',
          autocomplete: 'off',
        }),
      ]),
    );

    formElement.appendChild(
      el('div', { class: 'codflow-form__error', 'data-codflow-form-error': '', role: 'alert', hidden: 'hidden' }),
    );

    formElement.appendChild(
      el('button', { type: 'submit', class: 'codflow-submit', 'data-codflow-submit': '' }, [
        this.form.submitButtonText,
      ]),
    );

    body.appendChild(formElement);

    this.attachListeners(formElement);
    this.applyVisibility();
  }

  /** Order summary: what the shopper is buying and what they will hand over. */
  /**
   * The tick-box add-ons, between the order summary and the fields.
   *
   * Placed there deliberately: after the shopper has seen what they are buying
   * and before they start typing, which is when an extra is an easy yes rather
   * than an interruption.
   *
   * Ticking one re-renders the summary in place rather than the whole form —
   * a full re-render would discard every field the shopper had already filled.
   */
  private buildBumps(): HTMLElement {
    const list = el('div', { class: 'codflow-bumps', 'data-codflow-bumps': '' });

    for (const bump of this.config.bumps) {
      if (bump.defaultChecked && !this.bumpsSeeded) this.selectedBumps.add(bump.id);

      const id = `codflow-bump-${bump.id}`;
      const input = el('input', {
        type: 'checkbox',
        id,
        class: 'codflow-bump__input',
        'data-codflow-bump': bump.id,
      }) as HTMLInputElement;

      input.checked = this.selectedBumps.has(bump.id);

      input.addEventListener('change', () => {
        if (input.checked) this.selectedBumps.add(bump.id);
        else this.selectedBumps.delete(bump.id);

        this.refreshSummary();
      });

      list.appendChild(
        el('label', { class: 'codflow-bump', for: id }, [
          input,
          el('span', { class: 'codflow-bump__body' }, [
            el('span', { class: 'codflow-bump__title' }, [bump.title]),
            ...(bump.description
              ? [el('span', { class: 'codflow-bump__description' }, [bump.description])]
              : []),
          ]),
          el('span', { class: 'codflow-bump__price' }, [
            formatMoney(Number(bump.price), this.context),
          ]),
        ]),
      );
    }

    this.bumpsSeeded = true;
    return list;
  }

  private buildSummary(): HTMLElement {
    const product = this.context.product;
    // Shopify prices in Liquid are integer minor units.
    const unitPrice = product.price / 100;
    const subtotal = unitPrice * this.quantity;

    const pricing = this.config.pricing;
    const shipping =
      pricing.freeShippingAbove && subtotal >= Number(pricing.freeShippingAbove)
        ? 0
        : Number(pricing.shippingFee ?? 0);

    const codFee = pricing.codFeeEnabled
      ? pricing.codFeeIsPercent
        ? (subtotal * Number(pricing.codFeeAmount ?? 0)) / 100
        : Number(pricing.codFeeAmount ?? 0)
      : 0;

    const bumpTotal = this.config.bumps
      .filter((bump) => this.selectedBumps.has(bump.id))
      .reduce((sum, bump) => sum + Number(bump.price), 0);

    const total = subtotal + shipping + codFee + bumpTotal;

    const rows: HTMLElement[] = [];

    const row = (label: string, amount: number, modifier = ''): HTMLElement =>
      el('div', { class: `codflow-summary__row ${modifier}` }, [
        el('span', {}, [label]),
        el('span', {}, [formatMoney(amount, this.context)]),
      ]);

    rows.push(row('Subtotal', subtotal));
    if (shipping > 0) rows.push(row('Delivery', shipping));
    if (codFee > 0) rows.push(row('Cash on delivery fee', codFee));

    // Named individually rather than as one "Extras" line, so the total a
    // shopper sees can be reconciled against the boxes they ticked.
    for (const bump of this.config.bumps) {
      if (this.selectedBumps.has(bump.id)) rows.push(row(bump.title, Number(bump.price)));
    }

    rows.push(row('Total', total, 'codflow-summary__row--total'));

    const header = el('div', { class: 'codflow-summary__product' }, [
      ...(this.form.showProductImage && product.featuredImage
        ? [el('img', { src: product.featuredImage, alt: '', class: 'codflow-summary__image' })]
        : []),
      el('div', {}, [
        el('p', { class: 'codflow-summary__title' }, [product.title]),
        el('p', { class: 'codflow-summary__qty' }, [`Quantity: ${this.quantity}`]),
      ]),
    ]);

    return el(
      'div',
      { class: 'codflow-summary', 'data-codflow-summary': '' },
      [header, ...rows],
    );
  }

  /**
   * Looks up a postal code and fills city and state from it.
   *
   * Debounced, because this fires on every keystroke and the lookup crosses the
   * network: typing a six-digit PIN would otherwise make six requests, five of
   * them for codes that cannot resolve. The wait is short enough that the fields
   * appear to fill as the shopper finishes typing.
   *
   * A stale response is discarded rather than applied. Someone who corrects a
   * digit has two lookups in flight, and the slower one — for the *old* code —
   * can land second and overwrite the right answer with the wrong city. The
   * sequence number is what makes that impossible.
   */
  private schedulePostalLookup(raw: string): void {
    window.clearTimeout(this.postalTimer);

    const postalCode = raw.trim();
    const country = this.postalCountry(postalCode);

    if (!supportsPostalLookup(country)) return;

    // Nothing to say about a half-typed code. Clearing keeps a message from a
    // previous value from sitting under a field the shopper is still editing.
    if (!isValidPostalFormat(country, postalCode)) {
      this.setPostalStatus(null);
      return;
    }

    const sequence = ++this.postalSequence;

    this.postalTimer = window.setTimeout(() => {
      void this.runPostalLookup(country, postalCode, sequence);
    }, 350);
  }

  /**
   * Which country's rules apply.
   *
   * The form's own country field wins when the shopper has chosen one;
   * otherwise the shop's own country is the best available guess, and it is
   * right for the overwhelming majority of COD stores, which ship domestically.
   */
  private postalCountry(postalCode = ''): string {
    // 1. What the shopper picked. Always wins — they know where they live.
    const chosen = this.values.country;
    if (typeof chosen === 'string' && chosen.trim().length === 2) return chosen.trim().toUpperCase();

    // 2. The shop's own country, when the app can resolve postal codes there.
    //    Right for the domestic-only stores that are the overwhelming majority.
    const shopCountry = (this.context.shop.countryCode ?? '').toUpperCase();
    if (supportsPostalLookup(shopCountry)) return shopCountry;

    /*
     * 3. Infer it from the code's own shape.
     *
     * A store registered in one country while selling into another is common —
     * a Shopify account opened with a US address shipping COD across India is
     * the case that prompted this. Without inference the shopper must pick the
     * country *before* the PIN field does anything, which is exactly backwards
     * from how they fill a form and reads as the feature being broken.
     *
     * Only an unambiguous match counts. If two supported countries shared a
     * format, guessing would put the wrong state on a parcel, so the shopper is
     * left to choose instead.
     */
    const matches = Object.keys(POSTAL_FORMATS).filter((code) =>
      isValidPostalFormat(code, postalCode),
    );

    if (matches.length === 1 && postalCode) return matches[0] as string;

    return shopCountry || 'IN';
  }

  private async runPostalLookup(
    country: string,
    postalCode: string,
    sequence: number,
  ): Promise<void> {
    this.setPostalStatus('Checking…');

    let result: PostalLookupResult | null = null;

    try {
      const params = new URLSearchParams({
        shop: this.context.shop.domain,
        country,
        code: postalCode,
      });

      const response = await request<{ data: PostalLookupResult }>(
        'GET',
        `${PROXY_BASE}/postal?${params.toString()}`,
        { timeoutMs: 6_000 },
      );

      if (response.status >= 200 && response.status < 300) result = response.body.data;
    } catch {
      // Swallowed on purpose. The shopper types the two fields themselves and
      // the order proceeds; a lookup outage must not read as a broken form.
    }

    // A newer keystroke has already superseded this request.
    if (sequence !== this.postalSequence) return;

    if (!result || result.status === 'unavailable') {
      this.setPostalStatus(null);
      return;
    }

    if (result.status === 'found') {
      this.applyResolvedAddress(result);
      this.setPostalStatus(
        result.city && result.state ? `${result.city}, ${result.state}` : null,
        'ok',
      );
      return;
    }

    this.setPostalStatus(result.message, 'error');
  }

  /**
   * Writes the resolved city and state into their fields.
   *
   * Left editable rather than locked. The lookup is right almost always, and
   * "almost" is the problem: a shopper whose locality is recorded under a
   * neighbouring district needs to be able to correct it, and a disabled field
   * would send them away instead. Filling and letting them override is strictly
   * better than deciding for them.
   */
  private applyResolvedAddress(result: PostalLookupResult): void {
    const fill = (key: string, value: string | null): void => {
      if (!value) return;

      const field = this.form.fields.find((candidate) => candidate.key === key);
      if (!field) return;

      this.values[key] = value;

      const control = this.root.querySelector<HTMLInputElement | HTMLSelectElement>(
        `[name="${CSS.escape(key)}"]`,
      );

      if (!control) return;

      if (control instanceof HTMLSelectElement) {
        const match = Array.from(control.options).find(
          (option) => option.value.toLowerCase() === value.toLowerCase(),
        );

        if (match) {
          control.value = match.value;
        } else {
          /*
           * The resolved value is not in the list, so add it and select it.
           *
           * A state select is routinely empty — the merchant never typed 36
           * Indian states into the form builder — and matching against nothing
           * would leave a required field blank after an otherwise successful
           * lookup, which reads as the feature being broken. The postal
           * provider is authoritative for which state a PIN code is in, so
           * trusting it over an unconfigured list is the right way round.
           */
          const injected = el('option', { value }, [value]);
          control.appendChild(injected);
          control.value = value;
        }
      } else {
        control.value = value;
      }

      // Clear any stale "required" error the shopper has already seen on a
      // field that is now filled.
      if (this.touched.has(key)) this.validateOne(key);
    };

    fill('city', result.city);
    fill('province', result.state);

    /*
     * The country too, when the shopper has not chosen one.
     *
     * The lookup already had to decide which country's rules applied in order
     * to resolve the code at all, so leaving the field blank afterwards makes
     * the form ask for something it has just worked out — and on a required
     * field that is one more reason to abandon. Never overwrites a choice the
     * shopper made themselves.
     */
    const chosen = this.values.country;
    if (typeof chosen !== 'string' || chosen.trim().length !== 2) {
      fill('country', result.countryCode);
    }
  }

  /** The line under the postal field: progress, the resolved area, or a reason. */
  private setPostalStatus(message: string | null, tone: 'ok' | 'error' | null = null): void {
    const field = this.form.fields.find((candidate) => candidate.type === 'POSTAL_CODE');
    if (!field) return;

    const wrapper = this.root.querySelector(`[data-codflow-field="${field.key}"]`);
    if (!wrapper) return;

    let node = wrapper.querySelector<HTMLElement>('[data-codflow-postal-status]');

    if (!message) {
      node?.remove();
      return;
    }

    if (!node) {
      node = el('p', { class: 'codflow-help', 'data-codflow-postal-status': '' });
      // After the error slot, so the two never fight for the same line.
      wrapper.appendChild(node);
    }

    node.textContent = message;
    node.classList.toggle('codflow-postal-status--ok', tone === 'ok');
    node.classList.toggle('codflow-postal-status--error', tone === 'error');
    // Announced politely: it updates while the shopper is still typing, and an
    // assertive live region would interrupt them mid-word.
    node.setAttribute('role', 'status');
  }

  private refreshSummary(): void {
    if (!this.form.showOrderSummary) return;

    const existing = this.root.querySelector('[data-codflow-summary]');
    if (!existing || !existing.parentNode) return;

    existing.parentNode.replaceChild(this.buildSummary(), existing);
  }

  private attachListeners(formElement: HTMLFormElement): void {
    formElement.addEventListener('input', (event) => this.onInput(event));
    formElement.addEventListener('change', (event) => this.onInput(event));

    // Validation on blur rather than on every keystroke: telling someone their
    // email is invalid while they are still typing the domain is noise.
    formElement.addEventListener(
      'blur',
      (event) => {
        const target = event.target as HTMLElement | null;
        const key = target?.getAttribute('name');
        if (!key || key === HONEYPOT_FIELD_NAME) return;
        this.touched.add(key);
        this.validateOne(key);
      },
      true,
    );

    formElement.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit(formElement);
    });
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!target) return;

    const key = target.getAttribute('name');
    if (!key || key === HONEYPOT_FIELD_NAME) return;

    const field = this.form.fields.find((candidate) => candidate.key === key);
    if (!field) return;

    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      this.values[key] = target.checked;
    } else if (target instanceof HTMLSelectElement && target.multiple) {
      this.values[key] = Array.from(target.selectedOptions).map((option) => option.value);
    } else {
      this.values[key] = target.value;
    }

    if (field.type === 'QUANTITY') {
      const parsed = Number(target.value);
      this.quantity = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
      this.refreshSummary();
    }

    if (field.type === 'POSTAL_CODE') {
      this.schedulePostalLookup(String(target.value ?? ''));
    }

    // Visibility can change on any input, since another field may depend on it.
    this.applyVisibility();

    // Re-validate only what the shopper has already engaged with, so errors
    // clear as they fix them without appearing on fields they have not reached.
    if (this.touched.has(key)) this.validateOne(key);
  }

  /** Applies conditional visibility using the shared resolver. */
  private applyVisibility(): void {
    const visible = resolveVisibility(this.form.fields, this.values);

    for (const field of this.form.fields) {
      const wrapper = this.root.querySelector(`[data-codflow-field="${field.key}"]`);
      if (!wrapper) continue;

      const shouldShow = visible[field.key] && !field.hidden && field.type !== 'HIDDEN';

      if (shouldShow) {
        wrapper.removeAttribute('hidden');
      } else {
        wrapper.setAttribute('hidden', '');
        // A hidden field's error is stale by definition — the shopper cannot
        // see the field, so they cannot act on the message.
        this.showError(field.key, null);
      }
    }
  }

  private showError(key: string, message: string | null): void {
    const node = this.root.querySelector(`#${CSS.escape(errorId(key))}`);
    const wrapper = this.root.querySelector(`[data-codflow-field="${key}"]`);
    const control = this.root.querySelector(`[name="${CSS.escape(key)}"]`);

    if (node) {
      node.textContent = message ?? '';
      if (message) node.removeAttribute('hidden');
      else node.setAttribute('hidden', '');
    }

    if (wrapper) wrapper.classList.toggle('codflow-field--invalid', Boolean(message));
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  private validateOne(key: string): void {
    const field = this.form.fields.find((candidate) => candidate.key === key);
    if (!field) return;

    const visible = resolveVisibility(this.form.fields, this.values);
    if (!visible[key]) return;

    const error = validateField(field, this.values[key] ?? null);
    this.showError(key, error ? error.message : null);
  }

  private setFormError(message: string | null): void {
    const node = this.root.querySelector('[data-codflow-form-error]');
    if (!node) return;

    node.textContent = message ?? '';
    if (message) node.removeAttribute('hidden');
    else node.setAttribute('hidden', '');
  }

  private async submit(formElement: HTMLFormElement): Promise<void> {
    if (this.submitting) return;

    this.setFormError(null);

    // The same function the API will run. If it passes here it will pass there,
    // barring a server-side rule the browser cannot evaluate.
    const result = validateForm(this.form, this.values);

    if (!result.valid) {
      for (const error of result.errors) {
        this.touched.add(error.key);
        this.showError(error.key, error.message);
      }

      // Focus and scroll to the first problem. Without this a long form shows
      // an error the shopper has to hunt for.
      const first = result.errors[0];
      if (first) {
        const control = this.root.querySelector<HTMLElement>(`[name="${CSS.escape(first.key)}"]`);
        control?.focus();
        control?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    this.submitting = true;
    const button = formElement.querySelector<HTMLButtonElement>('[data-codflow-submit]');
    const originalLabel = button?.textContent ?? '';

    if (button) {
      button.disabled = true;
      button.textContent = this.context.strings.loading ?? 'Placing your order…';
    }

    try {
      const payload = {
        formToken: this.formToken,
        formId: this.form.id,
        lineItems: [
          {
            variantId: String(this.context.product.variantId),
            quantity: this.quantity,
          },
        ],
        // Coerced with the shared coercer so the server receives the same
        // shapes the client validated, not raw DOM strings.
        values: Object.fromEntries(
          this.form.fields
            .filter((field) => result.visibility[field.key])
            .map((field) => [field.key, coerceValue(field, this.values[field.key] ?? null)]),
        ),
        locale: this.context.shop.locale,
        attribution: this.readAttribution(),
        consent: this.readConsent(),
        bumpIds: [...this.selectedBumps],
        [HONEYPOT_FIELD_NAME]:
          (formElement.querySelector<HTMLInputElement>(`[name="${HONEYPOT_FIELD_NAME}"]`)?.value ??
            ''),
      };

      const response = await request<
        | {
            data: {
              reference: string;
              successMessage: string;
              total: string;
              orderToken?: string;
            };
          }
        | { error: { message: string; details?: { fields?: Record<string, string> } } }
      >('POST', `${PROXY_BASE}/order`, { body: payload });

      const body = response.body;
      const ok = response.status >= 200 && response.status < 300;

      if (!ok || 'error' in body) {
        const error = 'error' in body ? body.error : null;

        // Field-level errors from the server bind straight back onto the inputs
        // — most often the phone number, which the server validates per-country
        // with a library the browser does not carry.
        const fields = error?.details?.fields;
        if (fields) {
          for (const [key, message] of Object.entries(fields)) {
            this.touched.add(key);
            this.showError(key, message);
          }
        }

        this.setFormError(error?.message ?? (this.context.strings.errorBody ?? 'Something went wrong.'));
        return;
      }

      this.renderSuccess(body.data.successMessage, body.data.reference);

      emit('codflow:order:created', {
        reference: body.data.reference,
        total: body.data.total,
      });

      if (body.data.orderToken) {
        void this.handOffToShopify(body.data.reference, body.data.orderToken);
      }
    } catch (error) {
      this.setFormError(this.context.strings.errorBody ?? 'Something went wrong. Please try again.');
    } finally {
      this.submitting = false;
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }

  private readAttribution(): Record<string, string> {
    const params = new URLSearchParams(window.location.search);
    const attribution: Record<string, string> = {};

    const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    for (const key of utm) {
      const value = params.get(key);
      if (value) {
        const camel = key.replace(/_(.)/g, (_, character: string) => character.toUpperCase());
        attribution[camel] = value.slice(0, 200);
      }
    }

    if (document.referrer) attribution.referrer = document.referrer.slice(0, 1_000);
    attribution.landingPage = window.location.href.slice(0, 1_000);

    // Meta and TikTok click ids, read from the cookies their own pixels set.
    // Passing them through is what lets Phase 6 attribute a server-side
    // conversion back to the ad that produced it.
    const cookie = (name: string): string | null => {
      const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return match?.[1] ? decodeURIComponent(match[1]) : null;
    };

    const fbp = cookie('_fbp');
    const fbc = cookie('_fbc');
    if (fbp) attribution.fbp = fbp.slice(0, 200);
    if (fbc) attribution.fbc = fbc.slice(0, 500);

    const ttclid = params.get('ttclid');
    const gclid = params.get('gclid');
    if (ttclid) attribution.ttclid = ttclid.slice(0, 500);
    if (gclid) attribution.gclid = gclid.slice(0, 500);

    return attribution;
  }

  /**
   * Reads Shopify's own customer privacy decision.
   *
   * The app does not ask for consent itself — the merchant's banner already
   * did, and asking twice is both annoying and legally muddier. When the API is
   * unavailable the answer is false, because an absent decision is not consent.
   */
  private readConsent(): { marketing: boolean; analytics: boolean; saleOfData: boolean } {
    const privacy = (
      window as unknown as {
        Shopify?: { customerPrivacy?: { currentVisitorConsent?: () => Record<string, string> } };
      }
    ).Shopify?.customerPrivacy;

    try {
      const consent = privacy?.currentVisitorConsent?.() ?? {};
      return {
        marketing: consent.marketing === 'yes',
        analytics: consent.analytics === 'yes',
        saleOfData: consent.sale_of_data === 'yes',
      };
    } catch {
      return { marketing: false, analytics: false, saleOfData: false };
    }
  }

  /**
   * Sends the shopper to Shopify's own order-status page once the order exists.
   *
   * The push to Shopify is asynchronous — deliberately, because it can be slow
   * or throttled and a shopper should not watch a spinner while the app
   * negotiates with an API they have no relationship with. So there is nothing
   * to redirect *to* at the moment of submission, and this polls until there is.
   *
   * The in-app confirmation is rendered first and stays on screen throughout.
   * That ordering is the point: if the push is slow, fails, or is held for fraud
   * review, the shopper has already been told their order was placed. The
   * Shopify page is an upgrade on that, never a precondition for it.
   */
  private async handOffToShopify(reference: string, orderToken: string): Promise<void> {
    const params = new URLSearchParams({
      shop: this.context.shop.domain,
      reference,
      token: orderToken,
    });

    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      let result: { pushed: boolean; orderStatusUrl: string | null } | null = null;

      try {
        const response = await request<{
          data: { pushed: boolean; orderStatusUrl: string | null };
        }>('GET', `${PROXY_BASE}/order-status?${params.toString()}`, { timeoutMs: 8_000 });

        if (response.status >= 200 && response.status < 300) result = response.body.data;
        // A 4xx means the token is bad or expired; polling on would only repeat
        // the same answer.
        else if (response.status >= 400 && response.status < 500) return;
      } catch {
        // A failed poll is not a failed order. Keep trying until the deadline.
      }

      if (result?.orderStatusUrl) {
        this.notePendingRedirect();
        window.location.assign(result.orderStatusUrl);
        return;
      }
    }

    /*
     * Timed out. Not an error worth showing: the order is placed and the
     * confirmation is on screen. It usually means the push is still queued —
     * or that no worker is running, which is a merchant-side problem the
     * shopper can do nothing about.
     */
  }

  /** Tells the shopper why the page is about to change under them. */
  private notePendingRedirect(): void {
    const body = this.root.querySelector('[data-codflow-body]');
    if (!body) return;

    body.appendChild(
      el('p', { class: 'codflow-help', role: 'status' }, ['Taking you to your order details…']),
    );
  }

  private renderSuccess(message: string, reference: string): void {
    const body = this.root.querySelector('[data-codflow-body]');
    const title = this.root.querySelector('.codflow-dialog__title');

    if (!body || !title) return;

    title.textContent = message;
    body.innerHTML = '';

    body.appendChild(
      el('div', { class: 'codflow-success', role: 'status' }, [
        el('p', { class: 'codflow-success__message' }, [message]),
        el('p', { class: 'codflow-success__reference' }, [`Order reference: ${reference}`]),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point, called by codflow.js
// ---------------------------------------------------------------------------

async function fetchForm(locale: string): Promise<StorefrontFormResponse> {
  const params = new URLSearchParams({ locale });

  const response = await request<{ data: StorefrontFormResponse }>(
    'GET',
    `${PROXY_BASE}/form?${params.toString()}`,
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Form request failed: ${response.status}`);
  }

  return response.body.data;
}

export async function mountForm(options: RenderOptions): Promise<void> {
  const body = options.root.querySelector('[data-codflow-body]');

  try {
    // Cached for the page's lifetime, but *not* across page loads: the response
    // carries an expiring form token, and reusing a stale one fails at submit.
    if (!cachedForm) {
      cachedForm = await fetchForm(options.context.shop.locale);
    }

    new CodFormController({ ...options, response: cachedForm }).render();
  } catch (error) {
    if (body) {
      body.innerHTML = '';
      body.appendChild(
        el('div', { class: 'codflow-form__error', role: 'alert' }, [
          options.context.strings.errorBody ?? 'We could not load the order form.',
        ]),
      );
    }
  }
}

// Published for `codflow.js`, which loads this bundle lazily and has no module
// system of its own to import through.
(window as unknown as { CodFlowForm: { mount: typeof mountForm } }).CodFlowForm = {
  mount: mountForm,
};
