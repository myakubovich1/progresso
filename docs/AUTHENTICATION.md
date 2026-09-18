# Authentication setup and verification

Progresso supports Google sign-in, email/password signup, confirmation-email resend, and password recovery through the existing Supabase project. New accounts enter the existing onboarding flow; returning accounts open their own workspace.

## Required hosted configuration

1. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` before building the app. Keep demo mode off. These are public project identifiers, not elevated credentials.
2. In Supabase Authentication, enable the Email provider and **Confirm email**. Set the minimum password length to at least 8. The confirmation switch is mandatory: disabling it makes Supabase automatically mark new addresses as confirmed, which application code cannot distinguish from an actual confirmation.
3. Set the Auth **Site URL** to the exact deployed origin, such as `https://your-app.example`. Allow `https://your-app.example/auth/callback` and `http://localhost:3000/auth/callback` under Redirect URLs. Use explicit deployment origins rather than unrestricted production wildcards. Account for Supabase's `sb_flow_id` query parameter if your redirect rules restrict queries.
4. Configure a production SMTP provider in Supabase and verify its sender domain. Test actual delivery, spam placement, and rate limits with addresses outside the project team. Supabase's default mail service is for evaluation and has delivery restrictions.
5. Install the email templates below, then complete the live verification checklist. Do not disable confirmation to work around a delivery issue.

## Google sign-in

In Google Auth Platform:

- Create a Web application OAuth client and configure Progresso's audience and consent-screen branding.
- Add the app origin under authorized JavaScript origins.
- Use the **Supabase provider callback URL**, copied from the Supabase Google provider screen, as the authorized redirect URI. It normally looks like `https://PROJECT_REF.supabase.co/auth/v1/callback`; this is different from the app's `/auth/callback`.
- Request only the standard identity scopes (`openid`, email, profile). The app does not request Drive, Calendar, or health access.
- Enter the Client ID and Client Secret in Supabase's Google provider settings and enable the provider. Do not place the Google secret in a `NEXT_PUBLIC_` variable or commit it.
- While the Google app is in testing, add the intended test users. Configure production audience/branding before wider launch.

The app's Google button uses Supabase OAuth with PKCE, account selection, and a fixed return URL. OAuth cancellation and provider errors return to a recoverable screen.

Provider reference: [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google).

## Confirmation and recovery emails

Copy `supabase/templates/confirmation.html` into **Confirm signup** and `supabase/templates/recovery.html` into **Reset password** in Supabase's email template settings. Suggested subjects: “Confirm your Progresso account” and “Reset your Progresso password”.

These templates send the single-use token hash to the app at `{{ .SiteURL }}/auth/callback`. This works when the email is opened on another device. The page requires a **Continue securely** click before consuming the token, helping prevent mail previews from consuming links. The URL is removed from browser history immediately and the route uses no-store/no-referrer headers. Reloading the scrubbed page requires reopening the original email.

Because the templates use `SiteURL`, use a separate staging/local Supabase project with its Site URL pointing at that app when testing another environment. Do not point production email recipients at a temporary preview deployment.

The default Supabase confirmation and recovery templates also work through PKCE, but the user must finish in the browser where they started. The callback preserves `sb_flow_id` during exchange, and handles missing verifiers/expired links with recovery instructions. Old implicit-flow token-fragment links are not accepted; request a fresh email after upgrading.

Template reference: [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates).

## Integration details

- The existing bearer-token API remains unchanged. This is client-side authentication; private data is never rendered server-side based on browser storage alone.
- `browserSupabase()` owns one persistent PKCE client. Automatic URL detection is disabled because the dedicated callback explicitly exchanges credentials exactly once, including under React Strict Mode.
- `AuthGate` reacts to initial sessions, sign-ins, refreshes, cross-tab sign-outs, and account changes. Workspace state is keyed by user ID and fully unmounted on sign-out so the next account cannot inherit the previous account's uploads, meal draft, search answer, or timeline.
- Each production API request verifies the bearer token through `auth.getUser()` and rejects unconfirmed email accounts. Supabase's Confirm email setting remains the primary authentication enforcement for direct database/storage clients. Existing ownership RLS is retained.
- Sign-out is local to this browser (including its tabs), rather than logging the user out of every device.
- Email resends have a 60-second interface cooldown; Supabase must enforce actual server-side rate limits. Reloading the page can reset the UI timer.
- Password reset uses the same callback. Users choose and confirm a new password before continuing. Raw provider messages and URL descriptions are never rendered.
- The app requests no elevated database credentials. Provider configuration is outside the repository; merging this code does not enable a disabled Google provider or configure email delivery.

## Live acceptance checklist

Run on the intended deployment with real provider configuration:

- Google: new user → consent → onboarding; returning user → existing workspace; cancelled consent → usable retry; try a second Google account.
- Email: signup → inbox → explicit confirmation → onboarding; open the custom confirmation email on another device; ensure unconfirmed password sign-in leads to the resend screen.
- Resend: wait for cooldown, resend, use the latest email; confirm friendly handling of rate limits, expired links, duplicate signup, and wrong passwords.
- Recovery: request reset → email → new password → workspace; confirm wrong repeat passwords are blocked and the new password works after sign-out.
- Session: reload while signed in; expire/revoke a session; sign out in another tab; switch accounts and confirm no previous health state is visible.
- Mobile/keyboard: verify no horizontal overflow, visible focus, form labels, password toggle, and announcements of errors/status.

Automated tests mock Auth network boundaries and exercise the real UI, callbacks, and server guard. They do not prove real Google consent or email delivery. Run `npm run check` before merge; perform the live checklist before calling provider integration production-verified.
