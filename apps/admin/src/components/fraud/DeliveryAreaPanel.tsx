import { useEffect, useState } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Text,
  TextField,
} from '@shopify/polaris';
import { useUpdateVisibility, useVisibility } from '../../hooks/useVisibility';

/**
 * Postal codes you will and will not deliver to.
 *
 * Sits on the fraud screen because that is where merchants look for anything
 * list-shaped, but it is **not** a risk check and the copy says so. The two
 * behave differently in a way worth keeping straight:
 *
 *  - These prefixes run in `postal/service.ts` at PIN entry, so a shopper
 *    outside the area is told before they fill anything in.
 *  - A `POSTAL_CODE` entry in the block lists above scores the order *after*
 *    submission, and what happens then depends on the thresholds.
 *
 * Both are useful; they answer different questions. This one is "we do not
 * deliver there", not "this address looks dishonest".
 *
 * Saved through the shop visibility endpoint rather than the fraud one, because
 * that is where the columns live — the screen it appears on is a navigation
 * decision, not a storage one.
 */

const toLines = (values: readonly string[]) => values.join('\n');

const fromLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function DeliveryAreaPanel() {
  const { data: visibility } = useVisibility();
  const update = useUpdateVisibility();

  const [allowed, setAllowed] = useState('');
  const [blocked, setBlocked] = useState('');

  // Re-seeds on load and after a save returns the stored values.
  useEffect(() => {
    if (visibility) {
      setAllowed(toLines(visibility.allowedPostalPatterns));
      setBlocked(toLines(visibility.blockedPostalPatterns));
    }
  }, [visibility]);

  if (!visibility) return null;

  const dirty =
    allowed !== toLines(visibility.allowedPostalPatterns) ||
    blocked !== toLines(visibility.blockedPostalPatterns);

  const allowedCount = fromLines(allowed).length;
  const blockedCount = fromLines(blocked).length;

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Delivery area
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Prefixes, one per line — <code>560</code> matches every code starting 560. A shopper
            outside your area is told as soon as they enter their PIN, rather than after filling in
            the whole form.
          </Text>
        </BlockStack>

        <Banner tone="info">
          <p>
            This is delivery coverage, not a risk check. To treat an area as <em>suspicious</em>{' '}
            rather than unreachable, add its postal code to the block lists above — that scores the
            order instead of refusing it outright.
          </p>
        </Banner>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <TextField
            label="Only deliver to these postal codes"
            multiline={5}
            value={allowed}
            onChange={setAllowed}
            autoComplete="off"
            placeholder={'560\n110'}
            helpText={`${allowedCount} ${allowedCount === 1 ? 'prefix' : 'prefixes'}. Empty means everywhere.`}
          />
          <TextField
            label="Never deliver to these postal codes"
            multiline={5}
            value={blocked}
            onChange={setBlocked}
            autoComplete="off"
            placeholder={'682\n744'}
            helpText={`${blockedCount} ${blockedCount === 1 ? 'prefix' : 'prefixes'}.`}
          />
        </InlineGrid>

        <InlineStack align="end" gap="200">
          {dirty ? (
            <Button
              disabled={update.isPending}
              onClick={() => {
                setAllowed(toLines(visibility.allowedPostalPatterns));
                setBlocked(toLines(visibility.blockedPostalPatterns));
              }}
            >
              Discard
            </Button>
          ) : null}

          <Button
            variant="primary"
            disabled={!dirty}
            loading={update.isPending}
            onClick={() =>
              update.mutate({
                allowedPostalPatterns: fromLines(allowed),
                blockedPostalPatterns: fromLines(blocked),
              })
            }
          >
            {dirty ? 'Save delivery area' : 'Saved'}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
