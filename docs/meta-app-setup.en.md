# Meta app setup

This guide takes one MyChat installation from the Meta prerequisites to a real
Instagram event. Follow it once for your production installation: use its Meta
app, professional Instagram account, HTTPS callback, secrets and `.env` file.

> **Illustration placeholders:** replace every `[screenshot: ...]` marker with
> a current capture of the Meta UI during the external verification in phase 4e.
> The labels move occasionally, but the required values and checks below do not.

## Before you begin

- A public professional Instagram account, either Business or Creator.
- A public HTTPS URL for the privacy policy.
- A public HTTPS callback for the installation, for example
  `https://mychat.example.com/webhook`.

Never commit a token, app secret, verify token, or `.env` file. Use placeholders
in examples, such as `META_ACCESS_TOKEN=<token-from-meta>`.

## Overview

```text
Meta app -> Instagram Login permissions -> privacy policy
    -> HTTPS /webhook verification -> Instagram tester accepts invite
    -> access token + account ID -> event subscriptions -> Live mode
    -> real comment/message -> MyChat evidence
```

## 1. Create the app and choose the use case

At `developers.facebook.com/apps`, choose **Create app**. [screenshot: create
app]

Choose the Business Messaging use case, then **Manage messages and content on
Instagram**. Enter an app name and contact email. For the Instagram Login path,
you may choose not to connect a business portfolio. Keep the app identifier in
the environment record, not in source code.

## 2. Configure Instagram Login permissions

Open the use case, choose **Customize**, then **Instagram Login API setup**.
Use **Add all required permissions**. [screenshot: permissions]

The Instagram Login path needs:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Standard access is sufficient for an installation operating its own account.
Advanced Access and App Review can be required when the app operates accounts
for other people. Do not assume the two situations are interchangeable.

## 3. Add privacy policy and category

In **App settings -> Basic**, set the public Privacy Policy URL and choose the
Messaging category, then save. [screenshot: basic settings]

If publishing later says requirements are incomplete, return here first. The
missing privacy-policy URL or category is a common cause.

## 4. Configure and verify `/webhook`

Start MyChat before choosing **Verify and save**. Its callback must be public
and must answer the verification request immediately. In this environment's
private `.env`, set different values from every other environment:

```dotenv
META_APP_SECRET=<instagram-app-secret>
WEBHOOK_VERIFY_TOKEN=<long-random-verify-token>
META_ACCESS_TOKEN=<token-from-meta>
INSTAGRAM_ACCOUNT_ID=<professional-instagram-user-id>
```

`META_APP_SECRET` is the **Instagram App Secret** shown in the Instagram Login
API setup, not the general App Secret in App settings. They look similar, but
the wrong one makes every signed event fail validation.

Set the callback URL to the HTTPS URL ending in `/webhook`, and put the exact
same random value into Meta's Verify token field. [screenshot: webhook form]
Check it before saving, replacing the placeholders locally:

```bash
curl "https://test.example.com/webhook?hub.mode=subscribe&hub.verify_token=<verify-token>&hub.challenge=123"
```

The response must be exactly `123`. A `403` means the verify tokens differ; a
`502` or timeout means the public callback cannot reach MyChat. The `/webhook`
route must remain public: do not put dashboard authentication, Cloudflare
Access, or a login screen in front of it.

When the endpoint is accepted, Meta shows a green check and the **Webhook
fields** list. Use **Test** beside `comments` once and confirm that MyChat
records the event. This is the webhook connectivity check for the guide. Do not
use Meta's `messages` test as a direct-message test: it validates delivery to
the endpoint but does not emulate an inbound Instagram DM that MyChat can show.

## 5. Add and accept the Instagram tester invite

In **App roles -> Roles**, add the professional account as **Instagram Tester**
under the additional roles section. [screenshot: tester role]

The invite must be accepted by that account in Instagram, not in the developer
dashboard. Visit `https://www.instagram.com/accounts/manage_access/`, or use
Instagram settings, Apps and websites, Tester invites. A pending invite prevents
token generation.

## 6. Generate the token and find the account ID

Return to Instagram Login API setup and choose **Generate token** beside the
accepted account. Complete the Instagram consent flow. Store the token only in
the private `.env` for this environment.

Query the owner of the token without putting it in shell history:

```bash
TOKEN=$(grep '^META_ACCESS_TOKEN=' .env | cut -d= -f2-)
curl -s "https://graph.instagram.com/v23.0/me?fields=id,user_id,username,account_type&access_token=$TOKEN"
```

Use `user_id`, not `id`, as `INSTAGRAM_ACCOUNT_ID`. Confirm `account_type` is
`BUSINESS` or `MEDIA_CREATOR`. Restart MyChat after changing `.env`, since it
reads environment variables at startup.

## 7. Subscribe to events

In the app's webhook fields, subscribe the app to `comments` and `messages`.
Then enable **Webhook subscription** on the account's row. [screenshot: event
subscriptions]

These are two separate subscriptions. Confirm the account subscription with:

```bash
TOKEN=$(grep '^META_ACCESS_TOKEN=' .env | cut -d= -f2-)
curl -s "https://graph.instagram.com/v23.0/me/subscribed_apps?access_token=$TOKEN"
```

Its `subscribed_fields` must include both `comments` and `messages`. If comments
are absent, update the account subscription with the same private token, then
run the query again:

```bash
curl -s -X POST "https://graph.instagram.com/v23.0/me/subscribed_apps?subscribed_fields=comments,messages&access_token=$TOKEN"
```

## 8. Switch the app to Live mode

Open **Publish**, confirm all required configuration is complete, and publish
the app. [screenshot: publish live]

Development mode does not prove real delivery. Live mode is required before a
normal Instagram event can exercise an automation.

## 9. Perform a real automation test

Create or enable a small test automation in MyChat, then make a test comment on
a post owned by the configured professional account. If the automation sends a
private reply, confirm it in the conversation used for the comment.

Record all three pieces of evidence:

1. Meta sent an event to the HTTPS callback.
2. MyChat recorded and executed the automation.
3. The configured action completed as expected.

The successful test is not merely a configured token or a green callback
verification. It is the complete event, execution, and result observed by the
operator.

## Troubleshooting

| Symptom | Likely cause and recovery |
| --- | --- |
| Verify and save fails | Start MyChat, confirm public HTTPS reachability and matching `WEBHOOK_VERIFY_TOKEN`, then retry. |
| Every event has an invalid signature | Use the Instagram App Secret, not the general App Secret. Restart after correcting `.env`. |
| No token can be generated | Accept the Instagram Tester invitation inside Instagram and ensure the account is public and professional. |
| Messages work but comments do not | Verify both the app fields and account `subscribed_fields` contain `comments`. |
| The token works but sends fail | Use `user_id` as `INSTAGRAM_ACCOUNT_ID`, not the app-scoped `id`. |
| Nothing arrives after a real comment | Confirm Live mode and the public `/webhook` bypass. |
