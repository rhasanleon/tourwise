# TourWise

A lightweight, mobile-friendly group travel expense tracker. The frontend is designed for GitHub Pages; shared live data uses Firebase Firestore; SMS notifications use a Firebase HTTPS Function with Twilio.

## Features in this MVP

- Create a trip and generate a shareable invite URL.
- Add tour mates by name + phone number.
- Give every member an individual spending budget.
- Add expenses and select who shares each expense.
- Track total trip spending, per-person amount paid, budget remaining/overage.
- Automatically compute simplified "who owes whom" transfers.
- Send SMS status updates after an expense is added.
- Local demo mode works before Firebase is configured.

## Architecture

`GitHub Pages (HTML/CSS/JS)` → `Cloud Firestore` for synchronized trip state.

`GitHub Pages` → `Firebase HTTPS Function` → `Twilio Programmable Messaging` for SMS.

Never put a Twilio Account SID/Auth Token in GitHub Pages JavaScript. The browser source is public. Keep Twilio credentials in Firebase Functions secrets.

## 1. Test locally without Firebase

Because `config.js` is absent, the app automatically runs in browser-local demo mode.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Local demo mode is NOT shareable across phones.

## 2. Create Firebase project for live sharing

1. Create a Firebase project.
2. Enable Cloud Firestore.
3. Create a Web App in Firebase and copy its web config.
4. Copy `config.example.js` to `config.js` and paste the Firebase config.
5. Install Firebase CLI and log in.
6. In this folder run:

```bash
firebase use --add
firebase deploy --only firestore:rules
```

The included Firestore rules are intentionally simple for a trusted private travel group. The 32-character trip key acts like an unguessable invite token. For a larger/public product, add Firebase Authentication and stricter membership-based rules.

## 3. Enable Twilio SMS

Create a Twilio account and SMS-capable sender. For US messaging, follow Twilio's current sender verification / A2P registration requirements.

From the project root:

```bash
cd functions
npm install
cd ..
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_FROM_NUMBER
firebase deploy --only functions
```

After deployment, Firebase will show a function URL similar to:

`https://us-central1-PROJECT_ID.cloudfunctions.net`

Put that base URL in `config.js` as `window.TOURWISE_FUNCTIONS_URL`.

### Important: set the public trip URL in the function

In `functions/index.js`, replace:

`https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO/`

with your final GitHub Pages URL, then deploy the function again.

## 4. Publish on GitHub Pages

Create a GitHub repository (for example `tourwise`), commit these files, then in GitHub:

**Settings → Pages → Build and deployment → Deploy from a branch → main / root**

Because `.gitignore` excludes `config.js`, you have two choices:

- For a private/non-sensitive Firebase web config, remove `config.js` from `.gitignore` and commit it. Firebase web config identifiers are designed to be used in client apps; your actual data protection must come from Firestore Security Rules.
- Or inject `config.js` during a GitHub Actions deployment workflow.

Do NOT commit Twilio secrets.

## Expense mathematics

For each expense with amount `A` split among `k` selected members:

- payer's net balance increases by `A`,
- each selected member's net balance decreases by `A/k`.

Thus a positive net balance means the group owes that person; a negative balance means that person owes the group. The app greedily matches debtors to creditors, producing a small set of settlement transfers.

## Next improvements

Recommended second version: phone OTP sign-in, per-trip admin permissions, payment-settled records, custom unequal/percentage splits, receipt photos, export to CSV/PDF, trip categories, recurring expenses, offline-first PWA, and SMS consent/opt-out handling.
