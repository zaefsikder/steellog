// Same-origin by default (when served by FastAPI). When the frontend is
// hosted separately (e.g. GitHub Pages), set this to the deployed backend URL,
// e.g. "https://workout-schedule.fly.dev".
window.API_BASE = "";

// Neon Auth (Better Auth) base URL. Every /api/* call is authenticated with a
// Bearer JWT minted by this provider. Leave empty/undefined to run the frontend
// in local dev mode with no login gate (matches the backend's dev-auth mode).
window.NEON_AUTH_BASE_URL =
  "https://ep-empty-heart-av3788t8.neonauth.c-11.us-east-1.aws.neon.tech/neondb/auth";
