# Data Processing Addendum

**CODkar — Cash on Delivery for Shopify**

Last updated: 13 August 2026
Between: Identiwitty Media Pvt Ltd ("Processor") and the merchant installing CODkar ("Controller")

> **Draft, not legally reviewed.** Shopify's protected customer data
> requirements oblige app developers to "establish formal privacy and data
> protection agreements with merchants" — this is that agreement, and it needs a
> lawyer's review before you rely on it. Standard Contractual Clauses, where
> required, must be attached rather than summarised.

This addendum forms part of the [Terms of Service](terms).

## 1. Roles

The Controller is the merchant. They decide what personal data their COD form
collects and why.

The Processor is us. We process that data only to provide the app, and only on
the Controller's documented instructions — which are the app's configuration
together with these terms.

Where the Processor engages another company to help provide the service, that
company is a sub-processor and is listed in section 6.

## 2. Subject matter and duration

Processing lasts for as long as the app is installed, plus the period before
Shopify's shop redaction request arrives (48 hours after uninstall), after which
the Controller's data is deleted.

## 3. Categories of data subject

- Shoppers who submit a cash-on-delivery order on the Controller's store.
- Staff of the Controller who use the app's admin.

## 4. Categories of personal data

| Category | Fields |
|---|---|
| Identity | First name, last name |
| Contact | Phone number and its normalised form, email address |
| Location | Street address, apartment or landmark, city, state or province, postal code, country |
| Order | Contents, quantities, totals, currency, order reference |
| Technical | IP address, browser user-agent, browser-derived device identifier, one-way address digest |
| Merchant staff | Shopify staff identifier, recorded against configuration changes in the audit log |

No special category data as defined by GDPR Article 9 is processed. **No payment
card data is processed at any point** — cash on delivery involves no card.

## 5. Processor obligations

The Processor will:

1. Process personal data only on the Controller's documented instructions.
2. Ensure anyone authorised to process the data is bound by confidentiality.
3. Implement the technical and organisational measures in section 7.
4. Not engage a new sub-processor without notice to the Controller and an
   opportunity to object.
5. Assist the Controller in responding to data subject requests. Shopify's
   privacy request webhooks are wired to do this automatically: a customer data
   request returns everything held about that shopper, and a customer redaction
   request erases their personal fields.
6. Assist with data protection impact assessments and regulator consultations,
   so far as is reasonable.
7. Delete the Controller's data on shop redaction.
8. Make available the information needed to demonstrate compliance, and allow
   audits on reasonable notice.
9. Notify the Controller without undue delay on becoming aware of a personal
   data breach.

## 6. Sub-processors

| Sub-processor | Purpose | Data | Location |
|---|---|---|---|
| Shopify | Creating the order in the Controller's store | Full order | [REGION] |
| Render Services, Inc. | Running the application | All | [REGION] |
| Render Services, Inc. | Storage and job queue | All | [REGION] |
| Google | Exporting orders to the Controller's spreadsheet | Mapped order fields | [REGION] |
| Meta, TikTok, Google Ads, Snapchat, Pinterest | Conversion reporting | SHA-256 hashed identifiers, order value | [REGION] |
| [IP INTELLIGENCE PROVIDER] | Fraud signals | IP address | [REGION] |
| [EMAIL PROVIDER] | Merchant notifications | Merchant email, order reference | [REGION] |

Google, the advertising platforms and the IP intelligence provider are engaged
**only where the Controller enables that feature.** A merchant who connects
nothing has data flowing only to Shopify and the hosting stack.

Identifiers sent to advertising platforms are hashed with SHA-256 before
transmission. The underlying values do not leave the Processor's systems.

## 7. Technical and organisational measures

Implemented today:

- TLS on all traffic.
- Third-party OAuth and API credentials encrypted at rest with AES-256-GCM.
- Advertising credentials never exposed to a shopper's browser.
- Storefront requests verified as genuinely originating from the Controller's
  store before data is accepted.
- Tenant isolation: every query is scoped to the shop, and cross-shop access is
  structurally prevented at the repository layer.
- Audit log of configuration changes attributed to the acting staff member.
- Separate test and production environments.

To be confirmed and documented before listing — each is mandatory under
Shopify's Level 2 protected customer data requirements:

- [ ] Database encryption at rest
- [ ] Backup encryption
- [ ] Data loss prevention strategy
- [ ] Restriction and logging of staff access to production data
- [ ] Strong password and MFA policy for anyone with production access
- [ ] Documented security incident response procedure
- [ ] Defined maximum retention period for order records

## 8. International transfers

Where personal data is transferred outside the [EEA/UK/other applicable
region], the transfer is made under [MECHANISM — Standard Contractual Clauses,
adequacy decision, or other]. [ATTACH THE CLAUSES.]

## 9. Liability

Liability under this addendum is subject to the limits in the
[Terms of Service](terms).

## 10. Contact

Identiwitty Media Pvt Ltd
Plot No. 4-5, Block B, Lions Enclave, Vikas Nagar, Uttam Nagar, New Delhi, South West Delhi, Delhi 110059, India
srk@identiwitty.com
