import { BlockStack, Text, TextField } from '@shopify/polaris';

/**
 * The wording around the fields.
 *
 * These four strings live on `FormConfig` rather than on any field, the
 * storefront has always rendered them, and until now nothing in the admin could
 * change any of them — so every merchant's form said "Cash On Delivery" and
 * "Place Order" whether or not that suited their store.
 *
 * They are edited together because they are the same PATCH and the same
 * decision: the words a shopper reads on their way through the form. The submit
 * button is the one merchants ask for, and it is first for that reason.
 */

export interface FormCopy {
  headingText: string;
  subheadingText: string | null;
  submitButtonText: string;
  successMessage: string;
}

interface Props {
  copy: FormCopy;
  onChange: (copy: FormCopy) => void;
}

export function FormCopyEditor({ copy, onChange }: Props) {
  const patch = (values: Partial<FormCopy>) => onChange({ ...copy, ...values });

  return (
    <BlockStack gap="400">
      <BlockStack gap="100">
        <Text as="h2" variant="headingMd">
          Submit button and wording
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          What the shopper reads. The button&rsquo;s colours and shape come from your branding, so
          it matches the rest of your form.
        </Text>
      </BlockStack>

      <TextField
        label="Button text"
        value={copy.submitButtonText}
        onChange={(submitButtonText) => patch({ submitButtonText })}
        autoComplete="off"
        maxLength={120}
        placeholder="Place Order"
        helpText="Say what happens next — “Place Order” or “Confirm my order” beats “Submit”."
      />

      <TextField
        label="Heading"
        value={copy.headingText}
        onChange={(headingText) => patch({ headingText })}
        autoComplete="off"
        maxLength={200}
        placeholder="Cash On Delivery"
      />

      <TextField
        label="Sub-heading"
        value={copy.subheadingText ?? ''}
        onChange={(value) => patch({ subheadingText: value === '' ? null : value })}
        autoComplete="off"
        maxLength={500}
        multiline={2}
        helpText="Optional. The place to say “Pay when it arrives”."
      />

      <TextField
        label="Message after ordering"
        value={copy.successMessage}
        onChange={(successMessage) => patch({ successMessage })}
        autoComplete="off"
        maxLength={500}
        multiline={2}
        helpText="Shown once the order is placed, with the order reference beside it."
      />
    </BlockStack>
  );
}
