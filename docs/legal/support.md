# Support

**CODkar — Cash on Delivery for Shopify**

## Getting help

Email [SUPPORT EMAIL]. Target first response: [RESPONSE TIME], [SUPPORT HOURS].

Tell us your **store domain** and, where it is about a specific order, its
**CODkar reference** — the `CF-` code shown in the app. That is enough for us
to find it without asking you for anything else.

## Things that are usually not faults

**No COD button on my storefront.** The app embed has to be enabled on the theme
that is actually published — enabling it on a different theme does nothing. Check
**Visibility** in the app: COD switched off, a product excluded, a country not on
your allow list, or an order value outside your range will each hide the button
correctly.

**Orders are not reaching Shopify.** Open **Analytics → Orders**. The screen
groups them by cause: failed pushes show Shopify's own error, held orders are
waiting on fraud review or phone verification, and queued orders are on their
way. If the screen says orders are not being picked up, the background worker is
not running.

**A customer says their order was refused.** Fraud protection scored it above
your block threshold. **Fraud protection → Settings** shows the thresholds and
what each level does; individual orders can be reviewed and released.

**"We are unable to accept this order."** The generic refusal shown to a shopper.
The reason is deliberately withheld from them — naming the signal would tell
someone probing the form what to change. The reason is visible to you in the app.

**Google Sheets stopped syncing.** Google revokes access periodically.
**Settings → Google Sheets** shows the connection state and a reconnect button.

## Reporting a security issue

Email [SECURITY EMAIL] rather than using normal support. Please include enough
detail to reproduce the issue. We will acknowledge within [SECURITY RESPONSE
TIME] and will not take action against anyone reporting in good faith.

## Data requests

If you are a **shopper**, contact the store you ordered from. They can action
access and deletion requests, and those requests reach us automatically through
Shopify.

If you are a **merchant**, email [PRIVACY CONTACT EMAIL]. See the
[Privacy Policy](privacy).

## Status and emergencies

[STATUS PAGE URL, if you have one.]

Emergency developer contact is kept current in the Shopify Partner Dashboard, as
Shopify requires.
