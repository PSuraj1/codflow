import { useId } from 'react';
import { InlineStack, TextField } from '@shopify/polaris';

/**
 * A hex colour, entered either way.
 *
 * Polaris ships a `ColorPicker`, but it works in HSB and hands back an object —
 * converting to and from the hex string the API stores on every drag is a
 * source of rounding drift, and the merchant still cannot paste the hex from
 * their brand guidelines. So: a text field for the value that is actually
 * stored, beside the browser's own swatch for picking one.
 *
 * The swatch is a native input because there is no Polaris equivalent. It is
 * labelled for screen readers and is not the only way to set the value, so the
 * text field remains the accessible path.
 */

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helpText?: string;
}

/** The API refuses anything else, so the swatch must not be handed a partial. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColorField({ label, value, onChange, helpText }: Props) {
  const swatchId = useId();
  const valid = HEX.test(value);

  return (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        autoComplete="off"
        maxLength={7}
        helpText={helpText}
        // Reported as the merchant types rather than on save, because the
        // server refuses a malformed colour and the save bar would otherwise
        // report a failure with no indication of which field caused it.
        error={valid ? undefined : 'Use a hex colour such as #008060'}
      />

      <label htmlFor={swatchId} style={{ paddingTop: '1.55rem', display: 'block' }}>
        <span
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {label} colour picker
        </span>
        <input
          id={swatchId}
          type="color"
          value={valid ? value : '#000000'}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          style={{
            width: 36,
            height: 36,
            padding: 0,
            border: 'var(--p-border-width-025) solid var(--p-color-border)',
            borderRadius: 'var(--p-border-radius-200)',
            background: 'none',
            cursor: 'pointer',
          }}
        />
      </label>
    </InlineStack>
  );
}
