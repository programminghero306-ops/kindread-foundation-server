# Kindred Foundation

**Live URL:** _Add after deployment_

Express + MongoDB API for users, events, and joined events. Authentication uses
JWTs.

## Features

- Browse upcoming community events, sorted by date
- Create, edit, and delete your own events (creator-only)
- Join events with duplicate protection and leave them again
- JWT accounts with bcrypt-hashed passwords
- Search and filter events, plus joined and created event dashboards

## 1. What you need

- Node.js 18 or newer
- A MongoDB Atlas connection string (already in `.env`)
- A terminal opened in this project folder

## 2. First-time setup

```powershell
npm install
```

Make sure `.env` has these values (a template lives in `.env.example`):

```env
PORT=5000
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=your_long_random_secret

# Optional
DB_NAME=kindredDB
CLIENT_ORIGIN=http://localhost:5173
```

`CLIENT_ORIGIN` is a comma-separated list of allowed frontend origins. When it
is not set, the API reflects any origin (convenient for local development).

Start the server:

```powershell
npm run dev
```

You should see:

```text
Connected to MongoDB
Server running on port 5000
```

Check that the server is alive at <http://localhost:5000/health>. If you see
`Failed to start server`, check your Atlas connection string and make sure your
IP address is allowed in Atlas. The server only starts listening after MongoDB
connects, so requests fail loudly instead of silently returning 404s.

## 3. Create an account and get a token

PowerShell example:

```powershell
$base = "http://localhost:5000"
$email = "you@example.com"

$body = @{
  name = "Your Name"
  email = $email
  password = "secret123"
} | ConvertTo-Json

$res = Invoke-RestMethod -Method Post -Uri "$base/auth/register" `
  -ContentType "application/json" -Body $body

$token = $res.token
$headers = @{ Authorization = "Bearer $token" }

Write-Host "My token:" $token
```

If the account already exists, log in instead:

```powershell
$body = @{ email = $email; password = "secret123" } | ConvertTo-Json

$res = Invoke-RestMethod -Method Post -Uri "$base/auth/login" `
  -ContentType "application/json" -Body $body

$token = $res.token
$headers = @{ Authorization = "Bearer $token" }
```

Check who you are:

```powershell
Invoke-RestMethod -Uri "$base/auth/me" -Headers $headers
```

Every protected request must include this header:

```text
Authorization: Bearer <token>
```

## 4. Auth routes

| Method | Route | Body | Auth |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{ name, email, password, photoURL? }` | No |
| POST | `/auth/login` | `{ email, password }` | No |
| GET | `/auth/me` | none | Yes |
| PATCH | `/auth/me` | `{ name?, photoURL? }` | Yes |
| PATCH | `/auth/password` | `{ currentPassword, newPassword }` | Yes |

Both register and login return:

```json
{
  "token": "eyJ...",
  "user": { "_id": "...", "name": "...", "email": "...", "photoURL": "" }
}
```

Passwords are hashed with bcrypt before they are stored. Login and register are
rate limited (50 attempts per IP per 15 minutes).

Update your profile:

```powershell
$profile = @{
  name = "New Name"
  photoURL = "https://example.com/me.png"
} | ConvertTo-Json

Invoke-RestMethod -Method Patch -Uri "$base/auth/me" `
  -Headers $headers -ContentType "application/json" -Body $profile
```

Change your password:

```powershell
$passwords = @{
  currentPassword = "secret123"
  newPassword = "a-better-password"
} | ConvertTo-Json

Invoke-RestMethod -Method Patch -Uri "$base/auth/password" `
  -Headers $headers -ContentType "application/json" -Body $passwords
```

## 5. Event routes

| Method | Route | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/events` | Yes | Creates an event |
| GET | `/events` | No | Upcoming events, sorted by date |
| GET | `/events?limit=6` | No | Home page limit |
| GET | `/events?eventType=cleanup` | No | Filter by event type |
| GET | `/events?search=park` | No | Search title/description/location/type |
| GET | `/events/:id` | No | One event |
| PUT | `/events/:id` | Yes | Creator only |
| DELETE | `/events/:id` | Yes | Creator only; also removes its joins |
| POST | `/joined-events` | Yes | Join an event |
| GET | `/joined-events?email=` | Yes | Joined events, sorted by date |
| DELETE | `/joined-events/:id` | Yes | Leave an event (joined id or event id) |
| GET | `/my-events?email=` | Yes | Events created by the user |

Event `eventType` must be one of `cleanup`, `tree-planting`, `food-drive`,
`education`, `fundraiser`, `health`, `community`, or `other`. `eventDate` must
be a valid `YYYY-MM-DD` date.

For protected routes, the email in the token must match the email in the query/body.

### Create an event

```powershell
$eventBody = @{
  title = "Community Cleanup"
  description = "Help clean the park"
  eventType = "cleanup"
  thumbnail = "https://example.com/image.png"
  location = "Central Park"
  eventDate = "2026-12-01"
  creatorEmail = $email
} | ConvertTo-Json

$created = Invoke-RestMethod -Method Post -Uri "$base/events" `
  -Headers $headers -ContentType "application/json" -Body $eventBody

$eventId = $created.insertedId
```

### Get upcoming events

```powershell
Invoke-RestMethod -Uri "$base/events"
Invoke-RestMethod -Uri "$base/events?limit=6"
Invoke-RestMethod -Uri "$base/events/$eventId"
```

### Update an event

```powershell
$updateBody = @{ title = "Updated Cleanup" } | ConvertTo-Json

Invoke-RestMethod -Method Put -Uri "$base/events/$eventId" `
  -Headers $headers -ContentType "application/json" -Body $updateBody
```

### Delete an event

```powershell
Invoke-RestMethod -Method Delete -Uri "$base/events/$eventId" -Headers $headers
```

### Join an event

```powershell
$joinBody = @{
  eventId = $eventId
  user = @{ name = "Your Name"; image = "https://example.com/avatar.png" }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "$base/joined-events" `
  -Headers $headers -ContentType "application/json" -Body $joinBody
```

Joining the same event twice returns `409`.

### Get joined events

```powershell
Invoke-RestMethod -Uri "$base/joined-events?email=$email" -Headers $headers
```

Joined events use the current event details, so edits made by the creator show
up automatically.

### Leave an event

You can use either the joined-event id (`joinedId`) or the event id:

```powershell
Invoke-RestMethod -Method Delete -Uri "$base/joined-events/$eventId" `
  -Headers $headers
```

### Get events I created

```powershell
Invoke-RestMethod -Uri "$base/my-events?email=$email" -Headers $headers
```

## 6. Generate a test token without registering

```powershell
npm run token -- test@example.com "Test User"
```

This prints a token signed with your `JWT_SECRET`, valid for 7 days.

## 7. Common errors

| Status | Meaning | Fix |
| --- | --- | --- |
| 400 | Missing/invalid input | Check the request body or id |
| 401 | Missing, invalid, or expired token | Log in again and send `Authorization: Bearer <token>` |
| 403 | Token email does not match the requested email | Use the same email in the token and query/body |
| 404 | Event or user not found | Check the id |
| 409 | Duplicate account or duplicate join | Use another email or don't join twice |
| 429 | Too many login/register attempts | Wait 15 minutes and try again |
| 500 | Server error | Check the server terminal output |

## 8. Security notes

- `.env` is ignored by git. Never commit it.
- Change `JWT_SECRET` if it has ever been shared.
- Use HTTPS and a production MongoDB user in production.
- Passwords are hashed; plain passwords are never stored.
- Set `CLIENT_ORIGIN` in production so only your frontend can call the API.
- Helmet security headers and auth rate limiting are enabled.

## 9. Deploy

1. Create a MongoDB Atlas database user and allow your host's IP address.
2. Set `MONGODB_URI`, `JWT_SECRET`, `CLIENT_ORIGIN` and `PORT` in your host's
   environment settings.
3. Deploy this folder to a Node host such as Render or Railway. Start command:
   `npm start`.
4. Deploy the frontend with `VITE_API_URL` pointing at the deployed API URL.
5. Open `https://your-api-host/health` and confirm it returns
   `{"status":"ok","database":"connected"}`.

The server shuts down cleanly on `SIGINT`/`SIGTERM` and closes the MongoDB
connection.
