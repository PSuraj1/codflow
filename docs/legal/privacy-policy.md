# Privacy Policy

**CODkar — Cash on Delivery for Shopify**

Last updated: 13 August 2026
Published by: Identiwitty Media Pvt Ltd, Plot No. 4-5, Block B, Lions Enclave, Vikas Nagar, Uttam Nagar, New Delhi, South West Delhi, Delhi 110059, India
Contact: srk@identiwitty.com

> **This is a draft prepared from what the application actually does. It has not
> been reviewed by a lawyer. Every value in [SQUARE BRACKETS] must be filled in,
> and the whole document should be checked by someone qualified in the
> jurisdictions you operate in before you publish it.**

## Who this covers

CODkar is an application that merchants install on their Shopify store. It
lets a shopper place a cash-on-delivery order through a form rather than through
Shopify's checkout.

There are two relationships here, and they are legally different:

- **Merchants** who install CODkar. We are the *controller* of the account and
  billing information we hold about them.
- **Shoppers** who submit a cash-on-delivery order on a merchant's store. The
  merchant is the *controller* of that data. We are a *processor* acting on the
  merchant's instructions, and we do not decide what happens to it beyond
  providing the service.

If you are a shopper and want your data corrected or deleted, contact the store
you ordered from. They can action it, and Shopify's own privacy requests reach
us automatically.

## What we collect from shoppers

Only what the merchant's own form asks for, and only what is needed to create
their order:

- Name (first and last)
- Phone number, and a normalised form of it
- Email address, where the form collects one
- Delivery address — street, apartment or landmark, city, state or province,
  postal code, country
- Order contents, quantities and totals
- Any additional fields the merchant added to their own form

We also record, for fraud prevention and for no other purpose:

- IP address
- Browser user-agent string
- A device identifier derived from the browser
- A one-way digest of the delivery address, used to detect repeat orders to the
  same place without storing a second copy of the address

We do **not** collect payment card details. Cash on delivery involves no card,
and CODkar has no payment credentials of any kind.

## What we collect from merchants

- Shopify store domain, store name, contact email, country, currency, timezone
- The plan you are on and its status
- Configuration you enter — form fields, colours, fraud thresholds, block lists
- An audit log of configuration changes, attributed to the staff member who made
  them
- Access tokens for Shopify, and for Google and advertising platforms where you
  connect them

## Why we process it

| Purpose | Data used | Basis |
|---|---|---|
| Creating the cash-on-delivery order in Shopify | Name, phone, email, address, order contents | Performance of the merchant's contract with the shopper |
| Fraud and abuse prevention | Phone, email, address digest, IP, device identifier, order history | Legitimate interests of the merchant |
| Exporting orders to the merchant's Google Sheet | Order fields the merchant maps | The merchant's instruction |
| Conversion reporting to advertising platforms | Hashed identifiers only — see below | The merchant's instruction, subject to shopper consent |
| Notifying the merchant about orders | Merchant email | Performance of our contract with the merchant |
| Billing | Store domain, plan | Performance of our contract with the merchant |

We process the minimum needed for each purpose and do not use shopper data for
our own purposes, do not sell it, and do not use it to train models.

## Automated decision-making

CODkar scores every cash-on-delivery order for fraud risk. A merchant chooses
what happens at each score: allow, hold for their review, require phone
verification, or refuse the order.

**An order can therefore be refused automatically.** The shopper is told the
order could not be accepted and is not told which signal caused it — naming the
signal would tell someone probing the form exactly what to change.

**You can refuse automated decisions.** Where the merchant's form offers the
choice, you may decline automated decision-making on your order. If you do, the
order is still checked for risk — the merchant needs that information to decide
— but **it cannot be refused automatically**. Anything the system would have
refused is instead held for a person at the store to review and decide. This
applies even where the merchant has previously blocked your phone number or
email: the decision still becomes theirs to make rather than the system's.

Merchants can also switch fraud scoring off entirely, and can review and reverse
any individual decision. If you are a shopper and believe an order was wrongly
refused, contact the store; they can override it.

[LEGAL REVIEW NEEDED: where GDPR Article 22 applies, confirm whether an
automatic refusal constitutes a decision producing legal or similarly
significant effects, and whether the opt-out described above — which routes such
orders to human review — is sufficient, or whether it must be offered on every
form rather than at the merchant's discretion.]

## Who else sees the data

We use these sub-processors. Which of them apply depends on what the merchant
has connected.

| Sub-processor | What reaches them | When |
|---|---|---|
| Shopify | The full order, to create it in the merchant's store | Always |
| Render Services, Inc. | All data, as the platform it runs on | Always |
| Render Services, Inc. | All data at rest and in the job queue | Always |
| Google (Sheets and Drive) | The order fields the merchant maps to columns | Only if the merchant connects Google Sheets |
| Meta, TikTok, Google Ads, Snapchat, Pinterest | **SHA-256 hashes only** of email, phone, name, city, state, postal code, country — never the values themselves — plus the order value and a deduplication identifier | Only if the merchant configures that pixel with server-side sending |
| [IP INTELLIGENCE PROVIDER] | IP address | Only if the deployment has one configured |
| [EMAIL PROVIDER] | Merchant's notification email and order reference | Only for merchant notifications |

Advertising platforms receive **hashed** identifiers. Hashing is one-way: we
send a digest, the platform compares it against digests of its own users, and
the original value is never transmitted.

We request only Google's `drive.file` scope, which grants access solely to the
specific spreadsheet the merchant selects — not to the rest of their Drive.

## Security

- All traffic is over TLS.
- Third-party access tokens — Google and advertising platform credentials — are
  encrypted at rest with AES before being written to the database.
- Advertising platform credentials are never sent to a shopper's browser.
- Configuration changes are recorded in an audit log with the staff member
  responsible.
- Requests from a storefront are verified as genuinely originating from the
  merchant's store before any data is accepted.
- [TO CONFIRM: database encryption at rest, backup encryption, access controls
  on production, password and MFA policy for staff, and incident response
  procedure. Shopify's Level 2 protected customer data requirements make each of
  these mandatory — see `docs/legal/README.md`.]

## How long we keep it

**Personal details are erased after the store's retention period, which is one
year by default.** Each night, orders older than that period have the shopper's
name, phone number, email address, delivery address, order notes and device and
network details permanently cleared. What remains — amounts, dates and which
products were bought — is not personal data, and is kept so that a merchant's
own sales history does not change beneath them.

The period can be adjusted for an individual store on request, but cannot be
switched off.

Separately from that period:

- When a merchant uninstalls, their configuration and orders are retained but
  deactivated, so reinstalling does not lose their setup.
- When Shopify sends us a shop redaction request — 48 hours after uninstall, per
  Shopify's own process — the store and everything belonging to it is deleted.
- When Shopify sends us a customer redaction request, that shopper's personal
  fields are erased from our records.
- When Shopify sends us a customer data request, we return everything we hold
  about that shopper to the merchant.


## Shopper rights

Depending on where you live you may have rights to access, correct, delete,
port, or object to the processing of your personal data.

Because the merchant is the controller of shopper data, **please make these
requests to the store you ordered from**. They will reach us through Shopify's
privacy request process, and we action them within the timeframe Shopify
specifies.

Merchants may contact us directly at srk@identiwitty.com.

## Cookies and tracking

CODkar itself sets no advertising cookies. It stores a short-lived record in
the shopper's browser so a partly-filled form is not lost on reload.

Where a merchant has configured an advertising pixel, that platform's own script
may set cookies. Merchants can require cookie consent before any pixel fires,
and CODkar honours that setting.

## Changes

We will update this page when the service changes. Material changes will be
notified to merchants by email before they take effect.

## Contact

Identiwitty Media Pvt Ltd
Plot No. 4-5, Block B, Lions Enclave, Vikas Nagar, Uttam Nagar, New Delhi, South West Delhi, Delhi 110059, India
srk@identiwitty.com

[IF APPLICABLE: EU/UK representative and Data Protection Officer details.]
