# Linekeep Privacy Policy

Effective date: 6 November 2026

Linekeep is software that Elder Marketing ("we", "us") uses to keep a record of its business conversations with customers: WhatsApp messages, phone calls, and the customer details behind them. This policy explains what we collect, why, who it is shared with, how long we keep it and how to ask for it to be deleted. It applies to the Linekeep service we operate (the "Service"), including the Linekeep Android app used by our employees, the web dashboard used by our administrators, and our WhatsApp Business number.

Linekeep's source code is open source. This policy covers only the Service operated by Elder Marketing; anyone who runs their own copy is responsible for their own policy.

## Who this applies to

- **Customers and prospects** who contact us or whom we contact, by WhatsApp or by phone.
- **Our employees** who use the Linekeep app.
- **Our administrators** who use the dashboard.

## What we collect

### About customers and prospects

- Name, phone number and, when provided, email address, state, district, country and business details.
- Notes our team writes, the lead source and stage, and which employee handles the customer.
- WhatsApp conversations with our business number: message text, pictures, voice notes, documents and other files you send us, and the delivery status and time of each message. Your WhatsApp profile name is stored when WhatsApp gives it to us.
- Phone call records with our employees: your number, the time, the duration and whether the call was incoming, outgoing or missed.
- Recordings of calls with our employees, when the employee's phone recorded the call. We handle call recordings only where recording is lawful and permitted, and our employees are responsible for informing the other party that a call may be recorded.

### About employees

- Name and, optionally, a work contact number, which we may include in messages we send to customers.
- The phone's model, Android version and app version, the SIM numbers the phone reports, and when the phone last connected.
- The calls and recordings the employee's phone shares with the Service, and the chats the employee reads (so we can show unread counts).
- If an employee is made a **manager**, the manager can see their team's customers, chats, calls, recordings and call statistics in the Service, and can reassign those customers among the team. The employer sets who reports to whom.
- If the web app is switched on, the employee's sign-in email address, and for each browser they sign in on a session record (a hash of its cookie and its timestamps). Sign-in codes are sent to the employee by email or WhatsApp and are kept only as a short-lived hash.

- An **activity log** of what employees do in the Service, kept so the employer can see who did what and when: sign-ins and sign-outs to the web app (with the IP address and browser used, and failed or rate-limited attempts), the phone being enrolled, revoked or updated, batches of call history and recordings synced from the phone (counts and sizes, merged into one entry per phone per 15 minutes), customers added, edited, assigned or archived (which fields changed, never their new values), WhatsApp messages sent (the customer, the type of message and the template name, never the text) and files uploaded (kind and size), and call recordings played or deleted. The employee's "last active" time is also kept. Opening a chat or viewing a customer's calls is not logged.

### About administrators

- The email address used to sign in to the dashboard, and which chats each administrator has read.
- The same activity log records administrators' changes: adding or editing employees (which fields, not the values), phone and customer changes, settings saved (which settings, never the values), call recordings played or deleted, and messages sent from the dashboard.

### About customers in the activity log

The activity log notes that a customer's message arrived (the type of message only, never its text) and the automatic replies we send. It stores the customer's name as it was at the time; a customer whose name is only a phone number is shown masked to its last four digits. Message text, notes, phone numbers, one-time codes and file contents are never written to the activity log.

### What we do not collect

We do not collect your contacts list, location, photos or files from employees' phones other than the call recordings folder that the employee chooses to share. We do not use advertising or analytics trackers.

## How we use it

- To answer and follow up on customer enquiries and to keep a history of them.
- To assign customers to the right employee and notify that employee of new messages and new assignments.
- To send automatic replies and ready-made messages we have configured.
- To review calls and recordings for quality and training, and to resolve disputes.
- To produce internal summaries, such as a daily count of calls.
- To keep the Service secure and working.

We do not sell personal information and we do not use it for advertising.

## Who we share it with

We use these service providers to run the Service. They process data on our behalf:

| Provider | Purpose | What it sees |
|---|---|---|
| Meta Platforms (WhatsApp Business Platform) | Sending and receiving WhatsApp messages | Your WhatsApp number, messages and files, under Meta's own terms and privacy policy |
| Cloudflare | Hosting, the database, private file storage and administrator sign-in | All data in the Service, stored encrypted at rest |
| Google (Firebase Cloud Messaging) | Notifications to our employees' phones | Only the customer's name and the fact that there is a new message. Message text is never sent |
| Mailgun | Daily summary emails to our team | Counts and summary figures, not recordings or message text |

We may disclose information if the law requires it or to protect our legal rights.

## Where it is stored

The database and files are stored in Cloudflare's infrastructure, in its Asia-Pacific region by default. Data may pass through other regions where our providers operate.

## How long we keep it

- **Call recordings:** deleted automatically from storage after 30 days.
- **Call records, customer details and WhatsApp conversations:** kept for as long as we have a business relationship with you and as needed for our records, then deleted. You can ask us to delete them earlier (see below).
- **Employee data:** kept while the employee uses the Service, and removed on request when they leave.
- **Activity log:** entries older than 90 days are deleted automatically (an administrator can shorten the period, or choose to keep entries longer, in the dashboard's Config page). Only administrators can see it; employees cannot see the log, but they are told that their activity in Linekeep is recorded for the employer. Sign-in entries (IP address and browser) are in the same log and follow the same retention.

## Security

Recordings and files are kept in private storage that has no public address. Administrators sign in through Cloudflare Access. Phones connect with an individual credential that we can revoke at any time. WhatsApp webhooks are verified with a cryptographic signature. No system is perfectly secure, but we limit access to the people who need it.

## Your choices and rights

You can ask us to:

- tell you what we hold about you,
- correct it,
- delete it, or
- stop messaging you (reply STOP to any WhatsApp message, or tell us).

Email info@codinfuse.com from, or mentioning, the phone number we hold for you. We will confirm your identity from the number and respond within 30 days. See also [Data deletion instructions](DATA_DELETION.md).

## Children

The Service is for business use. It is not directed to anyone under 18, and we do not knowingly collect data about children.

## Changes

We may update this policy. The effective date above shows the latest version, and we will place the new version at this address.

## Contact

Elder Marketing  
Email: info@codinfuse.com
