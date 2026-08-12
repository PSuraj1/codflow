# Frequently asked questions

**CODkar — Cash on Delivery for Shopify**

Questions merchants ask most, answered plainly. If yours is not here, see
[Support](/legal/support).

## Setting up

### The COD button is not showing on my storefront

Almost always one of these, in order of how often it is the cause.

**The app embed is not enabled on the published theme.** This is the single most
common cause. CODkar ships with your theme but does nothing until you switch it
on: **Online Store → Themes → Customize → App embeds → CODkar — Cash on
Delivery → Save**.

The setting is **per theme**. If you changed theme, duplicated one, or installed
a new one, the embed does not come with it and has to be enabled again. The
setup checklist on the app's home page reads your published theme and tells you
which state it is in.

**COD is switched off, or the product is excluded.** Check **Settings →
Visibility**: COD turned off, a product excluded, a country outside your allow
list, or an order value outside your minimum or maximum will each hide the
button — correctly.

**You are looking at a different theme than the one you edited.** The theme
editor previews whatever theme you opened, which is not necessarily the
published one.

### Do I need to add a block to my product template?

No. Once the app embed is on, CODkar places the button on product pages
automatically, next to your Add to cart button.

The **CODkar — COD button** block exists for when you want it somewhere
specific instead — a different position on the product page, or on your cart
page. Adding the block without enabling the app embed does nothing, because the
embed is what loads the app.

### Can I move the button?

Yes, three ways, in increasing precision:

- **Settings → Buttons** controls appearance and which placements are active.
- **Add the app block** in the theme editor and drag it exactly where you want.
- **App embed → Advanced → anchor selector** takes a CSS selector, for themes
  where automatic placement lands in the wrong spot.

### Does CODkar change my theme files?

No. CODkar cannot modify your theme — it holds read-only theme permission, and
the button is drawn in the browser when the page loads. Turning the app embed
off removes it completely, and uninstalling leaves nothing behind.

## Taking orders

### How does a COD order reach Shopify?

The shopper fills in your form instead of going through checkout. CODkar prices
the cart against Shopify, creates the order as a draft, then completes it —
so it appears in **Orders** in your Shopify admin like any other order, marked
as payment pending, which is what cash on delivery is.

Every order also gets a CODkar reference beginning `CF-`, shown in the app and
written onto the Shopify order. Quote it when contacting support.

### Are prices taken from the shopper's browser?

No. The form sends product and variant identifiers only, never an amount. Every
price, fee and discount is re-resolved on our server against Shopify before the
order is created, so a manipulated page cannot change what is charged.

### What happens if an order fails to reach Shopify?

It is retried automatically. Anything still stuck is listed on the **Orders**
screen with a retry action, and the home page reports it under Store health.
The shopper is never shown a success message for an order that was not saved.

### Can shoppers order more than one item?

Yes. The button on a product page orders that product; a button placed on your
cart page orders everything in the cart.

## Fees, minimums and upsells

### Can I charge a COD fee?

Yes — a flat amount, a percentage, or free above a threshold, under
**Settings → Fees**. It is added as its own line on the Shopify order so your
reporting stays honest.

### Can I set a minimum or maximum order value?

Yes, under **Settings → Visibility**. Outside the range, the COD button does not
appear and the shopper sees your normal checkout.

### What are order bumps?

Flat-priced add-ons offered inside the COD form — a warranty, gift wrap, an
accessory. They are not Shopify products. They join the order **total** but never
the **subtotal**, so ticking one cannot clear your minimum order value, inflate a
percentage COD fee, or earn free delivery by accident.

## Fake orders and RTO

### How does CODkar reduce fake orders?

Every order is scored before it reaches you. Available checks include block
lists (phone, email, IP, postal code), PIN-code rules, disposable-email
detection, order-velocity limits and bot signals on the form itself.

An order that looks risky is **held for review** rather than shipped, and appears
on your dashboard under "Held for review". You decide.

### Will it block real customers?

The engine fails open on purpose: if scoring cannot run, the order is accepted
rather than refused. An outage in fraud checking should not become an outage in
your store.

### Can I block a specific customer?

Yes — **Settings → Fraud** takes phone numbers, emails, IP addresses and postal
codes, individually or in bulk.

## Google Sheets

### How do orders get into a spreadsheet?

**Settings → Google Sheets**: connect your Google account, pick or create a
sheet, and map the columns you want. New orders export automatically.

CODkar can only see spreadsheets it created plus any you explicitly pick. It
cannot browse your Drive.

### My existing orders did not export

The export covers orders CODkar created. Orders placed through your normal
Shopify checkout are not COD orders and are not part of it. Use **Export
existing orders** to backfill COD orders that predate connecting the sheet.

## Tracking and ads

### Why do my ad platforms not see COD orders?

Because COD orders skip Shopify checkout, so anything that measures conversions
at checkout never sees them. **Settings → Pixels** connects Meta, Google Ads,
TikTok, Snapchat or Pinterest so purchases are reported from our server as well
as the browser, with the same event id on both sides so the platform
de-duplicates them.

## Plans and billing

### What does it cost?

Free, Starter, Pro and Enterprise. Current prices, limits and what each plan
includes are on **Plan and usage** in the app — Shopify owns the pricing, so
that page is always accurate where a document could go stale. Starter and Pro
include a 3-day trial.

### What happens if I exceed my plan's order limit?

You are told in the app before it becomes a problem. Existing orders are never
deleted or hidden.

### How do I cancel?

Uninstall the app from your Shopify admin, or change your plan under **Plan and
usage**. Billing is handled by Shopify and appears on your Shopify invoice.

## Data and privacy

### What does CODkar store?

What a shopper types into your COD form — name, phone, address, and email if you
ask for it — plus the order it became. That is what an order needs to be
fulfilled.

### How long is it kept?

Personal fields are cleared automatically after your retention period (365 days
by default). The order and its totals remain for your reporting.

### What happens when I uninstall?

Access tokens are destroyed immediately and your store is marked inactive.
Shopify then sends a deletion request 48 hours later and personal data is
erased. Reinstalling within that window restores your settings.

### Is CODkar GDPR compliant?

CODkar implements Shopify's mandatory data-request, customer-redaction and
shop-redaction webhooks. See the [Privacy Policy](/legal/privacy) and the
[Data Processing Addendum](/legal/dpa).

## Regions and languages

### Which countries does CODkar work in?

Anywhere Shopify sells. The COD form, fees and fraud rules are country
agnostic. Automatic postal-code lookup — filling in city and state from a PIN
code — is currently India only; everywhere else the shopper types them.

### Does it support other languages?

The form ships in English, Hindi, Arabic, French, German and Spanish, and
follows your store's language settings. Arabic renders right-to-left.

## Still stuck?

See [Support](/legal/support) for how to reach us and what to include.
