# Google Cloud Console setup

This is a one-time setup, and it's free. You don't need a billing account: the
Google Calendar and People APIs have no charge, and a personal app stays far below its
usage limits.

You'll end up with a **client ID** and a **client secret**. They identify *your
app* to Google; they are not your password. Google's menus move around, so if a
label differs slightly, look for the closest match.

Sign in to the Cloud Console with the same Google account whose calendars you
want to see. Google Cloud requires **2-Step Verification** on that account. If
the console says "Google Cloud access blocked", turn it on at
<https://myaccount.google.com/signinoptions/twosv>, wait a few minutes, and
refresh.

---

## 1. Create a project

A *project* is Google Cloud's container for one app's settings and API access.

1. Open <https://console.cloud.google.com/>.
2. Click the project picker at the top left (it may say "Select a project"), then **New project**.
3. Name: `Calendar App` (anything works). Location/Organization: leave as is ("No organization" is fine).
4. Click **Create**, wait a few seconds, then make sure the new project is selected in the picker.

## 2. Enable the Google Calendar and People APIs

APIs are switched off by default in a new project. The People API is Google
Contacts, for Minuteman's Contacts window.

1. Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   (or **APIs & Services → Library**, search for "Google Calendar API").
2. Check that your project is selected at the top, then click **Enable**.
3. Do the same for <https://console.cloud.google.com/apis/library/people.googleapis.com>
   ("Google People API").

## 3. Configure the OAuth consent screen

The *consent screen* is the Google page that says "Minuteman wants to access your
Google Account". Here you give it a name and decide who can use it. In the
console this section is called **Google Auth Platform**.

1. Open <https://console.cloud.google.com/auth/overview> and click **Get started**.
2. **App information**
   - App name: `Minuteman` (it's what Google's sign-in page shows). Google
     rejects names that contain "Google".
   - User support email: your email.
3. **Audience**: choose **External**.
   ("Internal" only exists for Google Workspace organizations and only allows
   people inside that organization.)
4. **Contact information**: your email.
5. **Finish**: tick the box to agree to the Google API Services User Data Policy, then **Continue** and **Create**.

## 4. Add the Calendar and Contacts scopes

A *scope* is one specific permission the app asks for. The app asks for three:
reading your calendars, adding events to them, and using your contacts.

1. In Google Auth Platform, open **Data Access**.
2. Click **Add or remove scopes**.
3. In the filter box, type `calendar.readonly` and tick
   `https://www.googleapis.com/auth/calendar.readonly` ("See and download any calendar you can access").
4. Clear the filter, type `calendar.events` and tick
   `https://www.googleapis.com/auth/calendar.events` ("View and edit events on all your calendars").
5. Clear the filter, type `auth/contacts` and tick
   `https://www.googleapis.com/auth/contacts` ("See, edit, download, and permanently delete your contacts").
6. Click **Update**, then **Save** at the bottom of the page.

Accounts added before the app could create events only gave permission to
read. To add events to one, add it again (**Settings → Google accounts → Add account**, pick the
same account) and allow both on Google's page.

The same goes for contacts: accounts added before the Contacts window existed
didn't allow it. The Contacts window says so, with an **Allow…** button that
adds the account again; tick the contacts box on Google's page.

## 5. Create the "Desktop app" OAuth client

1. In Google Auth Platform, open **Clients** and click **Create client**.
2. Application type: **Desktop app**. Name: `Calendar desktop`.
3. Click **Create**.
4. A dialog shows the **Client ID** and **Client secret**. Click **Download JSON**
   or copy both values now. Google may not show the secret again. If you lose
   it, open the client and add a new secret.

Why "Desktop app": this client type lets the app receive Google's reply at
`http://127.0.0.1:<any port>` on your own machine. That's called a *loopback
redirect*. You don't register any redirect URLs for it.

About the "secret": a desktop app ships to users' computers, so anything inside
it can be read. Google knows this, and for Desktop clients it doesn't treat the
secret as truly secret. PKCE is what protects the sign-in. Google still requires
the value to be sent, so the app needs it. Keep it out of public repos anyway
(`.env` is git-ignored).

## 6. Publish the app ("In production")

1. In Google Auth Platform, open **Audience**.
2. Under **Publishing status** it says **Testing**. Click **Publish app**, then **Confirm**.
3. The status now says **In production**.

Why this matters:

- **In Testing**, Google expires refresh tokens after **7 days**. You'd have to
  sign in again every week, and only accounts listed as "test users" could sign in.
- **In production**, refresh tokens last until you revoke them, sign out, or
  change your Google password. (Google can also expire a token that goes
  unused for 6 months.)

### If "Publish app" is greyed out

As of October 2026, Google sometimes keeps **Publish app** disabled with "To
publish your app, you must complete your configuration on the Branding page",
even when Branding shows no errors. Many personal-app developers are reporting
this, and Google hasn't explained it yet. The scope list isn't the cause; removing it doesn't help.

Workaround: stay in **Testing** and add yourself as a test user:

1. **Audience → Test users → Add users**, enter your Gmail address, press
   Enter so it becomes a chip, then **Save**. Add every Google account you'll
   use in the app (Settings → Google accounts → Add account); one that isn't listed gets
   `Error 403: access_denied`.
2. Use the app normally. About every 7 days Google ends the sign-in, and the app
   shows "Your Google session ended" (or, for one of several accounts, "Google
   signed this account out"). Sign in again, or add the account again under
   **Settings → Google accounts**.

Try **Publish app** again now and then. Once it works, go to **Settings → Google
accounts → Add account** and pick each account again, to get tokens without the 7-day limit.

Filling in Branding's **App domain** section unlocks it (this project was
published that way on 2026-10-29). The repo's `site/` folder is a small home page
and privacy policy for that, published with GitHub Pages:

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub
   Actions**. Then **Actions → Publish website → Run workflow**. The pages are
   at `https://lukejs97.github.io/minuteman/` (the repo's name is the last part).
2. On Branding, under **App domain**: **Application home page**
   `https://lukejs97.github.io/minuteman/`, **Application privacy policy link**
   `https://lukejs97.github.io/minuteman/privacy.html`; leave Terms of service
   empty. Under **Authorized domains**, add `lukejs97.github.io`. **Save**.
3. On **Audience**, click **Publish app**. If it's still greyed out, hover over
   it: its tooltip may say what's still missing. Ignore the "Your app requires
   verification" banner that appears afterwards (see below).
4. Re-add each account in the app (Settings → Google accounts → Add account),
   since sign-ins made in Testing still expire after 7 days. Don't upload an
   app logo on Branding: that would make verification required.

You do **not** need to submit the app for Google's verification. Unverified
production apps work. Google limits them to 100 users in total and shows a
warning screen at sign-in, which is fine for a personal app. If the console
says verification is needed, you can ignore it.

## 7. Give the client ID and secret to the app

1. Copy `src-tauri/.env.example` to `src-tauri/.env`.
2. Paste your values:

   ```
   GOOGLE_CLIENT_ID=1234567890-xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
   ```

3. Start, or restart, `npm run tauri dev`. The values are built into the app,
   so a running app won't see changes until it rebuilds.

## 8. First sign-in

1. Click **Sign in with Google**. Your browser opens Google's sign-in page.
2. Pick your account. Because the app is unverified, Google shows
   **"Google hasn't verified this app"**. In production, click **Advanced**, then
   **Go to Minuteman (unsafe)** (or whatever app name you set on Branding). In Testing, just click **Continue**. It's your
   own app, so this is expected.
3. Tick the boxes to let the app see your calendars and contacts, and click **Continue**.
4. The browser tab says "You're signed in". Close it. The app shows your agenda.

If you signed in while the app was still in **Testing**, add each account again
after publishing (**Settings → Google accounts → Add account**; picking an account that's already
there renews it). Otherwise the old token still expires after 7 days.

## Troubleshooting

| Message | Meaning / fix |
| --- | --- |
| "The Google OAuth client isn't configured" | `src-tauri/.env` is missing or empty. Fix it, then restart `npm run tauri dev`. |
| `Error 400: redirect_uri_mismatch` in the browser | The client isn't a **Desktop app** type. Create a new client with the Desktop app type. |
| `Error 403: access_denied` / "has not completed the Google verification process" | The app is still in **Testing** and your account isn't a test user. Publish it (step 6). |
| "Google Calendar API has not been used in project … or it is disabled" | Do step 2 in the same project as your client. |
| "People API has not been used in project … or it is disabled" (in Contacts) | Enable the People API (step 2, item 3) in the same project. |
| "Your Google session ended" after a week | The token was issued while in Testing. Publish the app, then sign in again. |
| `invalid_client` | The client ID or secret in `.env` has a typo, or the secret was deleted. |
