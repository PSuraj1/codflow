# Legal pages — what is here, and what is still missing

These documents exist because the Shopify App Store listing needs them. They are
**drafts written from what the code actually does**, not boilerplate — the data
tables were compiled by reading the schema, the sub-processor list by reading
which integrations transmit what, and the security section by reading what is
actually encrypted.

**None of them has been reviewed by a lawyer. Do not publish as-is.**

| Document | Required? | Where it goes |
|---|---|---|
| [privacy-policy.md](privacy-policy.md) | **Mandatory.** Shopify: "Include a privacy policy in your listing." | Partner Dashboard → listing → privacy policy URL |
| [terms-of-service.md](terms-of-service.md) | Not named as mandatory, but expected for a paid app and needed to state a refund policy | Listing, and your own site |
| [data-processing-addendum.md](data-processing-addendum.md) | Required in substance: protected customer data Level 1 obliges "formal privacy and data protection agreements with merchants" | Linked from the privacy policy and terms |
| [support.md](support.md) | Recommended. The listing has a support URL and an emergency developer contact | Listing → support |

Served publicly at `/legal/privacy`, `/legal/terms`, `/legal/dpa` and
`/legal/support` so the URLs deploy with the app and stay valid.

## Before you submit

**Fill in every `[PLACEHOLDER]`.** Search for `[` across this directory. Company
name, registered address, contact addresses, jurisdiction, hosting and database
providers, refund policy, notice periods and support hours are all unfilled.

**Get a lawyer to read them.** Limitation of liability, warranty disclaimers and
governing law are jurisdiction-specific and unenforceable if worded wrongly. The
GDPR Article 22 question flagged in the privacy policy — whether automatically
refusing an order is a decision with legal or similarly significant effect —
needs a real answer, not a guess.

## Compliance gaps in the product, not the paperwork

CODkar accesses name, address, phone and email, which puts it at **Level 2** of
Shopify's protected customer data requirements. Two obligations used to be unmet
by the code, which made the corresponding paragraphs of the privacy policy
untrue. Both are now implemented:

1. **Retention limit — done.** `ShopSettings.orderRetentionDays` (365 by
   default, no "off" value) with a nightly sweep in `jobs/enforceRetention.ts`
   that clears the personal columns of orders past the cutoff. It blanks rather
   than deletes, sharing `shop/repository.REDACTION` with `customers/redact`, so
   a merchant's revenue history does not change when a retention period elapses.

2. **Shopper opt-out from automated scoring — done.** A merchant adds a
   `CONSENT` field keyed `profilingOptOut` to their form; the flag is stored on
   the order and read by `fraud/engine.ts`, which downgrades a `BLOCK` to
   `REVIEW` so a person decides. The order is still scored — the merchant needs
   the signal — and it is the only thing in the engine that outranks a blacklist
   entry, because a merchant's list cannot waive a shopper's right.

   **Still open:** nothing *obliges* a merchant to add that field, so a store
   that never does offers no opt-out. Whether the requirement is satisfied by
   making the route available or by forcing it onto every form is the open
   question flagged for legal review in the privacy policy. Seeding the field
   into `DEFAULT_FORM_FIELDS` would settle it in the product's favour.

The remaining Level 2 items — database and backup encryption, data loss
prevention, staff access restriction and logging, password policy, incident
response — are operational rather than code, and are unchecked boxes in the
addendum's section 7 until someone confirms them against the real deployment.
