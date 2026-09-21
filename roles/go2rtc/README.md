# go2rtc

## Nest Doorbell credentials

go2rtc's `nest:` source needs five values:

| Value | Where it comes from |
|---|---|
| `client_id`, `client_secret` | the GCP OAuth client you create below |
| `project_id` | Device Access Console, *not* the GCP project number |
| `refresh_token` | the exchange in step 3 |
| `device_id` | the `devices.list` call in step 4 |

### Before you start

Every one of these fails confusingly rather than loudly if it is missing.

- A **Device Access Console** project — <https://console.nest.google.com/device-access>,
  one-time $5 fee. This is where `PROJECT_ID` comes from.
- A **GCP project with the Smart Device Management API enabled**.
- An **OAuth 2.0 client of type "Web application"** with
  `https://www.google.com` in Authorized redirect URIs. It has to match
  byte-for-byte with the `redirect_uri` used in every step below.
- The scope `https://www.googleapis.com/auth/sdm.service` added to the OAuth
  consent screen.
- **The consent screen published to "In production".** Left in "Testing",
  Google expires the refresh token after seven days and the camera dies every
  week — the single most common way this setup breaks, and it breaks long
  after you have stopped thinking about it.

### 1. Authorize through the Partner Connections Manager

Substitute `PROJECT_ID` and `CLIENT_ID` and open it in a browser:

```
https://nestservices.google.com/partnerconnections/PROJECT_ID/auth?redirect_uri=https://www.google.com&access_type=offline&prompt=consent&client_id=CLIENT_ID&response_type=code&scope=https://www.googleapis.com/auth/sdm.service
```

`access_type=offline` and `prompt=consent` are both load-bearing. Drop either
one and Google hands back an access token with **no refresh token** — the flow
looks like it worked right up until the exchange in step 3 returns a response
missing the only field you wanted.

### 2. Grant access and copy the code

You land on `https://www.google.com?code=AUTH_CODE&scope=...`. Copy
`AUTH_CODE` out of the address bar. It is single-use and expires in a few
minutes, so do step 3 immediately.

### 3. Exchange the code for a refresh token

```bash
curl -L -X POST 'https://www.googleapis.com/oauth2/v4/token?client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=AUTH_CODE&grant_type=authorization_code&redirect_uri=https://www.google.com'
```

Keep `refresh_token` from the response — that is the durable credential. Keep
`access_token` too; step 4 needs it and it is only good for an hour.

### 4. Call `devices.list` — this is required, not a check

Google's docs: *"Authorization is not complete until you make your first
devices.list call with your new access token."* Skip it and the credentials
never come alive. It is also where `DEVICE_ID` comes from.

```bash
curl -X GET 'https://smartdevicemanagement.googleapis.com/v1/enterprises/PROJECT_ID/devices' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ACCESS_TOKEN'
```

`DEVICE_ID` is the last path segment of the device's `name` field.

### 5. Read `supportedProtocols` off the same response

Before writing the go2rtc URL, check
`sdm.devices.traits.CameraLiveStream.supportedProtocols` in that JSON.
**Trust it over Google's supported-devices table.** The table lists "Nest
Doorbell (legacy)" as RTSP-only, but a Nest Hello that has been migrated to
the Google Home app reports `["WEB_RTC"]` with `videoCodecs: H264` and
`audioCodecs: OPUS`. Google only documents the RTSP→WebRTC flip for Nest Cam
Indoor/Outdoor, so the docs are wrong here and the trait is the ground truth.

Two things downstream depend on the answer:

- **The go2rtc URL.** Append `&protocols=RTSP` for an RTSP camera; anything
  else falls through to WebRTC, because go2rtc's `pkg/nest/client.go` only
  tests `protocols[0] == "RTSP"`.
- **The Frigate recording preset.** WebRTC brings Opus audio, and mp4 cannot
  hold Opus — that stream needs `preset-record-generic-audio-aac`.
