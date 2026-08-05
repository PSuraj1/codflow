import { customAlphabet } from 'nanoid';
import { ORDER_REFERENCE_PREFIX } from '@codflow/shared';
import { InternalError } from '../../lib/errors';
import * as repository from './repository';

/**
 * Human-facing order references.
 *
 * Shown to the shopper on the confirmation screen and read back over the phone
 * when the merchant calls to confirm, which drives every choice below.
 *
 * The alphabet omits `0`, `O`, `1`, `I` and `L`. Those are the character pairs
 * people confuse when reading a code aloud or copying it from a screenshot, and
 * a merchant searching for the wrong one finds nothing. Losing five characters
 * costs almost nothing: 8 places over a 31-character alphabet is still ~8.5×10¹¹
 * combinations.
 *
 * Random rather than sequential, deliberately. A sequential reference tells
 * every customer how many orders the store takes — competitors included — and
 * makes another shopper's order trivially guessable.
 */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 8;
const MAX_ATTEMPTS = 5;

const generate = customAlphabet(ALPHABET, LENGTH);

/**
 * Produces a reference that is not already taken.
 *
 * `CodOrder.reference` carries a unique constraint, so the database is the real
 * arbiter — this loop only avoids surfacing a collision as an error. At this
 * keyspace a collision is vanishingly unlikely, but "unlikely" across millions
 * of orders is not "never", and a failed checkout is a lost sale.
 */
export async function nextReference(): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${ORDER_REFERENCE_PREFIX}-${generate()}`;

    if (!(await repository.referenceExists(candidate))) {
      return candidate;
    }
  }

  // Five collisions in a row is not chance — it is a broken random source or a
  // database returning stale reads. Either way, guessing again will not help.
  throw new InternalError('Could not allocate a unique order reference');
}
